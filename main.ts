// SPDX-License-Identifier: MIT
// Deep-dip mean-reversion bot for make.fun btc-race-24h-20261118-1444.
//
// Idea: BTC minute bars are mostly noise with rare sharp dips. This bot sits in
// cash almost all of the time and only buys a dip that is BOTH deep and already
// flattening, then exits on a modest take-profit, a tight stop, a trailing stop
// once in profit, or a maximum hold. One position at a time, long only, 80% of
// equity per trade, no new trades near the end of the window.
//
// Entry (all three must hold on the same bar):
//   (a) the close is at least 180 bps below the close 60 bars ago,
//   (b) the close is at least 80 bps below the 60-bar EMA of closes,
//   (c) the drop has flattened: the 5-bar return is at or above -30 bps.
// Exits (whole position, whichever comes first):
//   take profit +350 bps, stop loss -155 bps, trailing stop that arms at
//   +150 bps and sells on an 80 bps give-back from peak profit, max hold
//   150 bars. After any filled sell, wait 10 bars before buying again.
// No new positions once 1290 scored bars have passed (last ~150 bars).

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, Done } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const BPS = 10_000n;

// Entry thresholds (basis points).
const DIP_60_BPS = 200n; // (a) 60-bar fall must be at least this deep
const BELOW_EMA_BPS = 80n; // (b) close must be at least this far below the EMA
const FLAT_5_BPS = 30n; // (c) 5-bar return must be at or above -this
const EMA_LEN = 60n;
const LOOKBACK_60 = 60;
const LOOKBACK_5 = 5;

// Exits (basis points / bars).
const TAKE_PROFIT_BPS = 300n;
const STOP_LOSS_BPS = 150n;
const TRAIL_ARM_BPS = 150n;
const TRAIL_GIVEBACK_BPS = 80n;
const MAX_HOLD_BARS = 150;
const COOLDOWN_BARS = 10;

// Window shape: 1440 scored bars; stop opening new trades in the last 150.
const TOTAL_BARS = 1440;
const LATE_CUTOFF = TOTAL_BARS - 150;

// Sizing and slippage.
const SIZE_PCT = 80n; // percent of equity per buy
const MAX_SLIPPAGE_BPS = 150;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units

// Floor division for bigints (BigInt `/` truncates toward zero; for bps math we
// want the floor so a -155.9 bps move really reads below -155).
function divFloor(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  if (r !== 0n && ((r < 0n) !== (b < 0n))) return q - 1n;
  return q;
}

// Profit of `close` versus `entry`, in basis points (floored).
function profitBps(close: bigint, entry: bigint): bigint {
  return divFloor((close - entry) * BPS, entry);
}

const closes: bigint[] = [];
let ema: bigint | null = null;
let entryPrice: bigint | null = null;
let entrySeq = -1;
let peakBps = 0n;
let cooldownUntil = -1;
let orderCounter = 0;

function nextId(prefix: string, seq: number): string {
  orderCounter += 1;
  return `${prefix}-${seq}-${orderCounter}`;
}

await runBars({
  onHello(_state: BarsState): void {
    // No per-run setup needed beyond the module-level state above; the seed
    // is not used because the strategy is fully deterministic.
  },

  onBatch(state: BarsState, batch: Batch) {
    const close = state.close(SYMBOL);
    if (close === null) return [];

    // Track closes and the 60-bar EMA from every bar, warm-up included, so
    // the indicators are already warm when trading opens.
    closes.push(close);
    if (closes.length > 256) closes.splice(0, closes.length - 256);
    if (ema === null) {
      ema = close;
    } else {
      // EMA update: ema += (close - ema) * 2 / (60 + 1), integer math.
      ema = ema + divFloor((close - ema) * 2n, EMA_LEN + 1n);
    }

    // Learn entry / cooldown from this batch's fills (priced at this bar's
    // open, for orders decided on the previous bar).
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== "filled") continue;
      if (fill.side === "buy") {
        entryPrice = BigInt(fill.price);
        entrySeq = state.seq;
        peakBps = 0n;
      } else if (fill.side === "sell") {
        entryPrice = null;
        entrySeq = -1;
        peakBps = 0n;
        cooldownUntil = state.seq + COOLDOWN_BARS;
      }
    }

    const held = state.positions.get(SYMBOL);
    const qty = held === undefined ? 0n : held.qty;

    // ---- Manage an open position: exits first. ----
    if (qty > 0n) {
      if (entryPrice === null) {
        // Position exists but no fill was seen for it (should not happen);
        // anchor the entry at the current close so exits still work.
        entryPrice = close;
        entrySeq = state.seq;
        peakBps = 0n;
      }
      const profit = profitBps(close, entryPrice);
      if (profit > peakBps) peakBps = profit;

      const heldBars = state.seq - entrySeq;
      const takeProfit = profit >= TAKE_PROFIT_BPS;
      const stopLoss = profit <= -STOP_LOSS_BPS;
      const trailing =
        peakBps >= TRAIL_ARM_BPS && profit <= peakBps - TRAIL_GIVEBACK_BPS;
      const maxHold = heldBars >= MAX_HOLD_BARS;
      if (takeProfit || stopLoss || trailing || maxHold) {
        return [
          {
            side: "sell",
            client_id: nextId("s", state.seq),
            symbol: SYMBOL,
            qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
      return [];
    }

    // ---- Flat: consider a buy. ----
    if (state.warmingUp) return [];
    if (state.seq < cooldownUntil) return [];
    // Late-window cutoff: a dip in the last ~150 bars cannot complete
    // before the forced flatten at the end.
    const scoredBars = state.seq - state.warmupBars;
    if (scoredBars >= LATE_CUTOFF) return [];
    if (closes.length <= LOOKBACK_60) return [];
    if (ema === null) return [];

    const ref60 = closes[closes.length - 1 - LOOKBACK_60];
    const ref5 = closes[closes.length - 1 - LOOKBACK_5];
    // (a) 60-bar return at or below -180 bps: close * 10000 <= ref60 * 9820.
    const deepEnough = close * BPS <= ref60 * (BPS - DIP_60_BPS);
    // (b) close at least 80 bps below the EMA: close * 10000 <= ema * 9920.
    const belowEma = close * BPS <= ema * (BPS - BELOW_EMA_BPS);
    // (c) 5-bar return at or above -30 bps: close * 10000 >= ref5 * 9970.
    const flattened = close * BPS >= ref5 * (BPS - FLAT_5_BPS);
    if (!deepEnough || !belowEma || !flattened) return [];

    // Size: 80% of equity, capped by the SDK weight room and by cash.
    let notional = (state.equity * SIZE_PCT) / 100n;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    if (notional > state.cash) notional = state.cash;
    if (notional < MIN_NOTIONAL) return [];

    return [
      {
        side: "buy",
        client_id: nextId("b", state.seq),
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  },

  onDone(_state: BarsState, _done: Done): void {
    // Nothing to do: the harness flattens any open position at the end.
  },
});
