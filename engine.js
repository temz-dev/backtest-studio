/**
 * Backtest Studio — backtesting engine
 *
 * A faithful JavaScript port of the Python backtest engine in
 * ~/workspace/trading-bot/ (backtest_v1.py / backtest_v2.py), which was
 * verified against real Kraken daily candles (BTC, XRP) and Yahoo Finance
 * gold futures (GC=F) on 2026-11-26.
 *
 * Rules (identical for every run):
 *  - $10,000 starting equity, long-only spot, 0.1% fee per side.
 *  - Signals are computed on the daily close and executed at that close.
 *  - 30-bar warmup: every strategy and the buy-and-hold benchmark start at
 *    the close of bar 30, so the comparison is fair.
 *  - Buy-and-hold pays the fee on entry and on exit: final = 10000 / start
 *    * end * (1 - fee)^2.
 *
 * Strategies:
 *  - trend: EMA 9 crosses above EMA 21 -> buy; below -> sell.
 *  - meanReversion: RSI 14 below 30 -> buy; above 70 -> sell.
 *  - breakout: close above the 20-day high -> buy; below the 10-day low
 *    -> sell (Donchian 20/10).
 *
 * The engine is deterministic and makes no network calls. The same file runs
 * in the browser (window.BacktestStudio) and in Node (module.exports), so the
 * app and the test suite use identical code.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BacktestStudio = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var START_EQUITY = 10000;
  var FEE = 0.001; // 0.1% per trade side
  var WARMUP = 30;

  var STRATEGIES = {
    trend: {
      id: 'trend',
      name: 'Trend — EMA 9/21',
      short: 'Trend',
      description: 'Buy when the fast average (EMA 9) crosses above the slow average (EMA 21); sell when it crosses back below. Rides the trend, sits out the falls.'
    },
    meanReversion: {
      id: 'meanReversion',
      name: 'Mean reversion — RSI 14',
      short: 'Mean reversion',
      description: 'Buy when RSI 14 drops below 30 (oversold); sell when it rises above 70 (overbought). Bets the price snaps back to its average.'
    },
    breakout: {
      id: 'breakout',
      name: 'Breakout — Donchian 20/10',
      short: 'Breakout',
      description: 'Buy when the close breaks above the highest high of the last 20 days; sell when it falls below the lowest low of the last 10 days. Chases new highs.'
    }
  };

  function round2(x) { return Math.round(x * 100) / 100; }
  function round1(x) { return Math.round(x * 10) / 10; }

  // EMA with the seed = simple average of the first `period` values,
  // placed at index period - 1 (same as the Python engine).
  function ema(values, period) {
    var k = 2 / (period + 1);
    var out = new Array(values.length).fill(null);
    var seed = 0;
    for (var i = 0; i < period; i++) seed += values[i];
    seed /= period;
    out[period - 1] = seed;
    for (var j = period; j < values.length; j++) {
      out[j] = values[j] * k + out[j - 1] * (1 - k);
    }
    return out;
  }

  // RSI 14 (Wilder-style smoothing via a rolling simple average of gains
  // and losses, exactly as the Python engine does it).
  function rsi(closes, period) {
    period = period || 14;
    var out = new Array(closes.length).fill(null);
    var gains = [];
    var losses = [];
    for (var i = 1; i < closes.length; i++) {
      var ch = closes[i] - closes[i - 1];
      gains.push(Math.max(ch, 0));
      losses.push(Math.max(-ch, 0));
      if (i >= period) {
        var avgG = 0, avgL = 0;
        for (var j = gains.length - period; j < gains.length; j++) {
          avgG += gains[j];
          avgL += losses[j];
        }
        avgG /= period;
        avgL /= period;
        if (avgL === 0) {
          out[i] = 100;
        } else {
          out[i] = 100 - 100 / (1 + avgG / avgL);
        }
      }
    }
    return out;
  }

  // signals[i] = 1 buy, -1 sell, 0 hold.
  function signalsFor(bars, strategyId) {
    var n = bars.length;
    var closes = bars.map(function (b) { return b.close; });
    var sig = new Array(n).fill(0);

    if (strategyId === 'trend') {
      var e9 = ema(closes, 9);
      var e21 = ema(closes, 21);
      for (var i = 1; i < n; i++) {
        if (e9[i] === null || e21[i] === null || e9[i - 1] === null || e21[i - 1] === null) continue;
        if (e9[i - 1] <= e21[i - 1] && e9[i] > e21[i]) sig[i] = 1;
        else if (e9[i - 1] >= e21[i - 1] && e9[i] < e21[i]) sig[i] = -1;
      }
    } else if (strategyId === 'meanReversion') {
      var r = rsi(closes, 14);
      for (var k = 0; k < n; k++) {
        if (r[k] === null) continue;
        if (r[k] < 30) sig[k] = 1;
        else if (r[k] > 70) sig[k] = -1;
      }
    } else if (strategyId === 'breakout') {
      var highs = bars.map(function (b) { return b.high; });
      var lows = bars.map(function (b) { return b.low; });
      for (var m = 20; m < n; m++) {
        var hi20 = -Infinity, lo10 = Infinity;
        for (var a = m - 20; a < m; a++) if (highs[a] > hi20) hi20 = highs[a];
        for (var b2 = m - 10; b2 < m; b2++) if (lows[b2] < lo10) lo10 = lows[b2];
        if (closes[m] > hi20) sig[m] = 1;
        else if (closes[m] < lo10) sig[m] = -1;
      }
    }
    return sig;
  }

  // Run one strategy over the bars. Returns the summary stats (rounded
  // exactly like the Python engine), the equity curve, and the trade list.
  // Trades carry display fields (units, equity used, dollar P&L) that the
  // Python engine does not; the headline stats use the Python definitions
  // (win = price return > 0, ignoring fees).
  function runStrategy(bars, signals) {
    var equity = START_EQUITY;
    var position = 0; // units held
    var entryPrice = 0;
    var equityInTrade = 0; // cash committed at the buy
    var trades = [];
    var peak = equity;
    var maxDd = 0;
    var curve = []; // {t, value} mark-to-market, pre-trade, from bar WARMUP

    for (var i = WARMUP; i < bars.length; i++) {
      var price = bars[i].close;
      var cur = position ? equity + position * price : equity;
      if (cur > peak) peak = cur;
      var dd = peak ? (peak - cur) / peak : 0;
      if (dd > maxDd) maxDd = dd;
      curve.push({ t: bars[i].t, value: cur });
      var s = signals[i];
      if (s === 1 && position === 0) {
        position = equity / price * (1 - FEE);
        equityInTrade = equity;
        entryPrice = price;
        equity = 0;
        trades.push({ type: 'buy', bar: i, t: bars[i].t, price: price, units: position, cash: equityInTrade });
      } else if (s === -1 && position > 0) {
        var proceeds = position * price * (1 - FEE);
        var ret = (price - entryPrice) / entryPrice;
        trades.push({
          type: 'sell', bar: i, t: bars[i].t, price: price, units: position,
          ret: ret, pnl: proceeds - equityInTrade
        });
        equity = proceeds;
        position = 0;
      }
    }

    var finalEquity = position ? equity + position * bars[bars.length - 1].close : equity;
    // The curve's last point is pre-trade; if a trade fired on the last bar
    // the final value differs, so append it so the chart ends on the truth.
    if (curve.length && Math.abs(curve[curve.length - 1].value - finalEquity) > 0.01) {
      curve.push({ t: bars[bars.length - 1].t, value: finalEquity });
    }

    var sells = trades.filter(function (t) { return t.type === 'sell'; });
    var wins = sells.filter(function (t) { return t.ret > 0; }).length;

    return {
      summary: {
        finalEquity: round2(finalEquity),
        totalReturnPct: round2((finalEquity / START_EQUITY - 1) * 100),
        maxDrawdownPct: round2(maxDd * 100),
        trades: trades.length,
        roundTrips: sells.length,
        winRatePct: sells.length ? round1(wins / sells.length * 100) : null,
        stillHolding: position > 0
      },
      curve: curve,
      trades: trades
    };
  }

  // Buy-and-hold from the close of bar WARMUP, net of 0.1% in/out fees.
  function buyAndHold(bars) {
    var startPrice = bars[WARMUP].close;
    var endPrice = bars[bars.length - 1].close;
    var finalEquity = START_EQUITY / startPrice * endPrice * (1 - FEE) * (1 - FEE);
    var curve = [];
    for (var i = WARMUP; i < bars.length; i++) {
      // Entry fee applied from the start; the exit fee lands on the final point.
      curve.push({ t: bars[i].t, value: START_EQUITY * (1 - FEE) / startPrice * bars[i].close });
    }
    if (curve.length && Math.abs(curve[curve.length - 1].value - finalEquity) > 0.01) {
      curve.push({ t: bars[bars.length - 1].t, value: finalEquity });
    }
    return {
      summary: {
        finalEquity: round2(finalEquity),
        totalReturnPct: round2((finalEquity / START_EQUITY - 1) * 100),
        maxDrawdownPct: null,
        trades: 2,
        roundTrips: 1,
        winRatePct: null,
        stillHolding: false
      },
      curve: curve,
      trades: []
    };
  }

  // Keep only the bars inside the requested window, by calendar time.
  // '2Y' returns everything available; '1Y' the last 365 days; '6M' the last 182.
  function sliceByPeriod(bars, periodKey) {
    if (periodKey === '2Y') return bars.slice();
    var days = periodKey === '6M' ? 182 : 365;
    var cutoff = bars[bars.length - 1].t - days * 86400;
    var out = bars.filter(function (b) { return b.t >= cutoff; });
    return out.length > WARMUP + 5 ? out : bars.slice();
  }

  // Full backtest: strategy vs buy-and-hold on the same bars.
  function backtest(bars, strategyId) {
    if (!STRATEGIES[strategyId]) throw new Error('unknown strategy: ' + strategyId);
    if (!bars || bars.length < WARMUP + 10) throw new Error('not enough bars (need at least ' + (WARMUP + 10) + ')');
    var sig = signalsFor(bars, strategyId);
    var strat = runStrategy(bars, sig);
    var bh = buyAndHold(bars);
    return {
      strategyId: strategyId,
      bars: bars.length,
      startClose: bars[WARMUP].close,
      endClose: bars[bars.length - 1].close,
      startDate: bars[WARMUP].t,
      endDate: bars[bars.length - 1].t,
      strategy: strat.summary,
      strategyCurve: strat.curve,
      strategyTrades: strat.trades,
      buyAndHold: bh.summary,
      buyAndHoldCurve: bh.curve
    };
  }

  function fmtMoney(x) {
    return '$' + x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(x, signed) {
    var s = (signed && x > 0 ? '+' : '') + x.toFixed(2) + '%';
    return s;
  }
  function fmtDate(ts) {
    var d = new Date(ts * 1000);
    return d.toISOString().slice(0, 10);
  }

  return {
    START_EQUITY: START_EQUITY,
    FEE: FEE,
    WARMUP: WARMUP,
    STRATEGIES: STRATEGIES,
    ema: ema,
    rsi: rsi,
    signalsFor: signalsFor,
    runStrategy: runStrategy,
    buyAndHold: buyAndHold,
    sliceByPeriod: sliceByPeriod,
    backtest: backtest,
    fmtMoney: fmtMoney,
    fmtPct: fmtPct,
    fmtDate: fmtDate
  };
});
