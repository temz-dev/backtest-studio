# Backtest Studio

Pick an asset and a trading strategy, run a backtest on real historical daily
price data, and see the equity curve, return, drawdown, win rate and every
trade — next to buy-and-hold on the same chart.

Built for **Arbiter Hacks V1 (General Track)**. Solo entry. Static web app:
no build step, no server, no API keys. GitHub Pages-ready.

## What it does

- **Assets:** BTC, ETH, XRP, SOL (Kraken) and Gold (GC=F, Yahoo Finance).
- **Strategies:** Trend (EMA 9/21 crossover), Mean reversion (RSI 14,
  buy < 30 / sell > 70), Breakout (Donchian 20/10).
- **Periods:** 6M / 1Y / 2Y, sliced by calendar time from the data.
- **Results:** equity-curve chart (strategy vs buy-and-hold), stat cards
  (total return, final value, max drawdown, win rate, trades, price move),
  a full trade list with per-trade P&L, and a "beat / trailed the benchmark
  by Xpp" verdict line.
- **Verified presets:** one click runs a known result, e.g. BTC · Trend
  +16.4%, Gold · Trend +33.0%, ETH · Trend +112.1%, XRP · Trend −27.2%.
- **Live data toggle:** tries a live Kraken OHLC fetch; if it fails (CORS,
  network), it falls back to the bundled data and says so. Gold has no
  browser-usable live endpoint (Yahoo blocks cross-origin reads), so Gold
  always uses bundled data and says so. Nothing is ever presented as live
  when it is bundled.

## The rules — same for every run

- $10,000 starting equity, long-only spot. No leverage, no shorting.
- 0.1% fee on every buy and every sell — and on buy-and-hold's entry and
  exit too.
- Signals are computed on the daily close and executed at that close.
- 30-bar warmup: every strategy and the benchmark start at the close of
  bar 30, so the comparison is fair.
- Win rate counts completed round trips where the sell price was above the
  buy price.

## Data

Bundled datasets live in `data/` (one JSON per asset, with source, fetch
time and date range recorded in each file):

| Asset | Source | Range | Bars |
|-------|--------|-------|------|
| BTC | Kraken OHLC API | 6 Dec 2024 – 26 Nov 2026 | 721 |
| ETH | Kraken OHLC API | 6 Dec 2024 – 26 Nov 2026 | 721 |
| XRP | Kraken OHLC API | 6 Dec 2024 – 26 Nov 2026 | 721 |
| SOL | Kraken OHLC API | 6 Dec 2024 – 26 Nov 2026 | 721 |
| Gold | Yahoo Finance GC=F | 26 Nov 2024 – 26 Nov 2026 | 504 |

BTC, XRP and Gold are the exact datasets the verified Python backtests used
(fetched 2026-11-26 ~08:03 UTC; the final bar is the then-current day).
ETH and SOL were fetched fresh from Kraken the same morning. Bybit is
geo-blocked from this machine and is not used.

## Verified results (bundled data, 2Y window)

The JavaScript engine reproduces the verified Python backtests exactly
(see `tests/test_engine.js`):

| Run | Return | Final value |
|-----|--------|-------------|
| BTC · Trend | +16.37% | $11,636.99 |
| BTC · Mean reversion | −32.27% | $6,772.74 |
| BTC · Breakout | −23.57% | $7,642.92 |
| BTC · Buy & hold | −38.52% | $6,147.63 |
| Gold · Trend | +32.97% | $13,296.74 |
| Gold · Mean reversion | −14.84% | $8,515.52 |
| Gold · Breakout | +12.78% | $11,278.19 |
| Gold · Buy & hold | +32.10% | $13,210.00 |
| XRP · Trend | −27.21% | $7,279.02 |
| XRP · Mean reversion | −52.89% | $4,711.21 |
| XRP · Breakout | −41.94% | $5,806.19 |
| XRP · Buy & hold | −60.32% | $3,968.42 |

The honest read, already visible in the app: only the trend strategy made
money, and only in 2 of 3 markets. Mean reversion lost in all three.

On the fresh ETH/SOL data (no Python target to match, engine-checked only):
ETH · Trend +112.11% ($21,211.25), SOL · Trend +0.11% ($10,010.65).

## Run it

```sh
cd arbiter-backtest-studio
python3 -m http.server 8130
# open http://localhost:8000 — or just open index.html directly
```

`?data=bundled` forces the bundled dataset and skips the live-fetch attempt
(useful for demos and deterministic tests).

## Tests

```sh
npm install            # Playwright, for the e2e test (dev only)
node tests/test_engine.js   # unit tests incl. the reproduction targets
node tests/e2e.js           # Playwright: loads the app, runs each strategy
                            # on BTC, checks results + chart, screenshots
npm test                    # both
```

- Unit tests: **24/24 pass**, including all 12 reproduction targets.
- E2E tests: **23/23 pass**, zero console/page errors (expected sandbox
  network failures from the live-fetch attempt are filtered).

## Files

- `index.html`, `styles.css`, `app.js` — the app.
- `engine.js` — the backtesting engine (UMD: same code in the browser and
  in Node). A faithful port of `~/workspace/trading-bot/backtest_v1.py` and
  `backtest_v2.py`.
- `data/*.json` — bundled daily candles (see Data above).
- `tests/` — unit + e2e tests.
- `screenshots/` — landing, strategy results, Gold result, mobile 360px,
  full page.

## Disclaimer

Backtests are not predictions. A strategy that won over the last two years
can lose over the next two. Nothing here is financial advice.
