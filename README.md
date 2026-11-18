# btc-race-24h-20261118-1444-bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/competition/btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/beduldudul/btc-race-24h-20261118-1444-bot/rank.svg)](https://make.fun/competition/btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/beduldudul/btc-race-24h-20261118-1444-bot/reward.svg)](https://make.fun/competition/btc-race-24h-20261118-1444)

Deep-dip mean-reversion BTC trading bot for the [make.fun btc-race-24h-20261118-1444 competition](https://make.fun/competition/btc-race-24h-20261118-1444).

## Strategy

Trades Coinbase Wrapped BTC (CBBTC) vs USDC on 1-minute bars, starting from
$1,000 paper, long only, one position at a time. It sits in cash most of the
time and only buys a dip that is both deep and already flattening:

- the close is at least 150 bps below the close 60 bars ago,
- the close is at least 80 bps below the 60-bar EMA of closes,
- the 5-bar return is at or above -30 bps (the drop has flattened).

Each buy risks 80% of equity. It exits the whole position on whichever comes
first: take profit +300 bps, stop loss -150 bps, a trailing stop that arms at
+150 bps and sells on a 25 bps give-back from peak profit, or a maximum hold
of 150 bars. After any sell it waits 10 bars before buying again, and it
opens no new positions in the last ~150 bars of the window.

## Run

The bot speaks `agent-fun/bars-replay/v1` over NDJSON stdin/stdout via the
vendored SDK (`vendor/makefun-bars.ts`). Grade locally from the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
