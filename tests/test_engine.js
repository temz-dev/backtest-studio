/**
 * Backtest Studio engine unit tests.
 * Run:  node tests/test_engine.js
 * Exits 0 when every case passes, 1 otherwise.
 *
 * The reproduction cases check the JS engine against the verified Python
 * results (~/workspace/trading-bot/results/backtest_v1.json,
 * backtest_xrp.json, backtest_gold.json, computed 2026-11-26 from real
 * Kraken / Yahoo Finance daily candles). If the JS port is faithful, every
 * target reproduces within rounding.
 */
const fs = require('fs');
const path = require('path');
const engine = require('../engine.js');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name + ' — ' + e.message);
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(what + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

function near(actual, expected, tol, what) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tol) {
    throw new Error(what + ': expected ' + expected + ' ± ' + tol + ', got ' + actual);
  }
}

function loadAsset(sym) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', sym + '.json'), 'utf8'));
  return d.bars;
}

// --- Indicator math -------------------------------------------------------

check('EMA seeds with the simple average of the first period values', () => {
  const out = engine.ema([10, 20, 30, 40, 50], 3);
  eq(out[0], null, 'ema[0]');
  eq(out[1], null, 'ema[1]');
  eq(out[2], 20, 'ema[2] = (10+20+30)/3');
  // k = 2/4 = 0.5; ema[3] = 40*0.5 + 20*0.5 = 30
  eq(out[3], 30, 'ema[3]');
  eq(out[4], 40, 'ema[4]');
});

check('EMA 9/21 on a rising series: fast stays above slow', () => {
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 + i);
  const e9 = engine.ema(closes, 9);
  const e21 = engine.ema(closes, 21);
  if (!(e9[39] > e21[39])) throw new Error('fast EMA should be above slow on a rising series');
  if (e9[8] === null || e21[20] === null) throw new Error('seed positions wrong');
});

check('RSI is 100 on an all-gains series and 0 on an all-losses series', () => {
  const up = [];
  for (let i = 0; i < 30; i++) up.push(100 + i);
  const down = [];
  for (let i = 0; i < 30; i++) down.push(100 - i);
  eq(engine.rsi(up, 14)[29], 100, 'RSI all gains');
  eq(engine.rsi(down, 14)[29], 0, 'RSI all losses');
});

check('RSI is null before the first full period', () => {
  const closes = [];
  for (let i = 0; i < 30; i++) closes.push(100 + Math.sin(i));
  const r = engine.rsi(closes, 14);
  for (let i = 0; i < 14; i++) eq(r[i], null, 'rsi[' + i + ']');
  if (r[14] === null) throw new Error('rsi[14] should be defined');
});

check('RSI ~50 on a flat series with a single step', () => {
  // 14 gains of +1 then 14 losses of -1: at bar 28 the last 14 changes are
  // all losses, so RSI is 0; at bar 14 the last 14 changes are all gains.
  const closes = [100];
  for (let i = 0; i < 14; i++) closes.push(closes[closes.length - 1] + 1);
  for (let i = 0; i < 14; i++) closes.push(closes[closes.length - 1] - 1);
  const r = engine.rsi(closes, 14);
  eq(r[14], 100, 'RSI after 14 straight gains');
  eq(r[28], 0, 'RSI after 14 straight losses');
});

// --- Fee handling ----------------------------------------------------------

check('fees are charged on both sides of a round trip', () => {
  // Flat price, one forced buy then sell: 10000 -> 10000*(1-f)^2
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push({ t: 1700000000 + i * 86400, open: 100, high: 100, low: 100, close: 100 });
  const sig = new Array(40).fill(0);
  sig[35] = 1;
  sig[38] = -1;
  const res = engine.runStrategy(bars, sig);
  near(res.summary.finalEquity, 10000 * 0.999 * 0.999, 0.01, 'final equity after round trip');
  eq(res.summary.trades, 2, 'trade count');
  eq(res.summary.roundTrips, 1, 'round trips');
});

check('a buy signal while already in a position is ignored', () => {
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push({ t: 1700000000 + i * 86400, open: 100, high: 110, low: 90, close: 100 + i });
  const sig = new Array(40).fill(0);
  sig[31] = 1;
  sig[32] = 1; // second buy while holding
  sig[35] = -1;
  const res = engine.runStrategy(bars, sig);
  eq(res.summary.trades, 2, 'only one buy + one sell');
});

check('buy-and-hold pays entry and exit fees', () => {
  const bars = [];
  for (let i = 0; i < 40; i++) bars.push({ t: 1700000000 + i * 86400, open: 100, high: 100, low: 100, close: 100 });
  const bh = engine.buyAndHold(bars);
  near(bh.summary.finalEquity, 10000 * 0.999 * 0.999, 0.01, 'BH final on flat price');
});

check('backtest rejects an unknown strategy and too few bars', () => {
  const bars = loadAsset('btc');
  let threw = false;
  try { engine.backtest(bars, 'nope'); } catch (e) { threw = true; }
  if (!threw) throw new Error('unknown strategy should throw');
  threw = false;
  try { engine.backtest(bars.slice(0, 20), 'trend'); } catch (e) { threw = true; }
  if (!threw) throw new Error('too few bars should throw');
});

// --- Period slicing --------------------------------------------------------

check('sliceByPeriod keeps the full window for 2Y and shortens for 6M/1Y', () => {
  const bars = loadAsset('btc');
  eq(engine.sliceByPeriod(bars, '2Y').length, 721, '2Y length');
  const m6 = engine.sliceByPeriod(bars, '6M');
  const y1 = engine.sliceByPeriod(bars, '1Y');
  if (!(m6.length < y1.length && y1.length < 721)) throw new Error('6M < 1Y < 2Y expected, got ' + m6.length + '/' + y1.length + '/721');
  if (m6.length < 100) throw new Error('6M slice too short: ' + m6.length);
});

// --- Reproduction targets (verified Python results, 2026-11-26) ----------

function reproduction(asset, strategy, target) {
  const bars = loadAsset(asset);
  const res = engine.backtest(bars, strategy);
  near(res.strategy.finalEquity, target.final, 0.5, asset + ' ' + strategy + ' final equity');
  near(res.strategy.totalReturnPct, target.ret, 0.05, asset + ' ' + strategy + ' return %');
  if (target.dd !== undefined) near(res.strategy.maxDrawdownPct, target.dd, 0.05, asset + ' ' + strategy + ' max DD %');
  if (target.trades !== undefined) eq(res.strategy.trades, target.trades, asset + ' ' + strategy + ' trade count');
  if (target.winRate !== undefined && target.winRate !== null) near(res.strategy.winRatePct, target.winRate, 0.1, asset + ' ' + strategy + ' win rate');
  if (target.holding !== undefined) eq(res.strategy.stillHolding, target.holding, asset + ' ' + strategy + ' still holding');
  return res;
}

check('REPRO BTC trend +16.37% -> $11,636.99 (15 round trips, 26.7% wins)', () => {
  reproduction('btc', 'trend', { final: 11636.99, ret: 16.37, dd: 22.02, trades: 30, winRate: 26.7, holding: false });
});

check('REPRO BTC mean reversion -32.27% -> $6,772.74', () => {
  reproduction('btc', 'meanReversion', { final: 6772.74, ret: -32.27, dd: 49.5, trades: 17, winRate: 50.0, holding: true });
});

check('REPRO BTC breakout -23.57% -> $7,642.92', () => {
  reproduction('btc', 'breakout', { final: 7642.92, ret: -23.57, dd: 38.07, trades: 22, winRate: 36.4, holding: false });
});

check('REPRO BTC buy-and-hold -38.52% -> $6,147.63', () => {
  const res = engine.backtest(loadAsset('btc'), 'trend');
  near(res.buyAndHold.finalEquity, 6147.63, 0.5, 'BTC BH final');
  near(res.buyAndHold.totalReturnPct, -38.52, 0.05, 'BTC BH return');
});

check('REPRO XRP trend -27.21% -> $7,279.02', () => {
  reproduction('xrp', 'trend', { final: 7279.02, ret: -27.21, dd: 56.6, trades: 30, winRate: 26.7, holding: false });
});

check('REPRO XRP mean reversion -52.89% -> $4,711.21', () => {
  reproduction('xrp', 'meanReversion', { final: 4711.21, ret: -52.89, dd: 61.36, trades: 15, winRate: 28.6, holding: true });
});

check('REPRO XRP breakout -41.94% -> $5,806.19', () => {
  reproduction('xrp', 'breakout', { final: 5806.19, ret: -41.94, dd: 57.46, trades: 20, winRate: 30.0, holding: false });
});

check('REPRO XRP buy-and-hold -60.32% -> $3,968.42', () => {
  const res = engine.backtest(loadAsset('xrp'), 'trend');
  near(res.buyAndHold.finalEquity, 3968.42, 0.5, 'XRP BH final');
  near(res.buyAndHold.totalReturnPct, -60.32, 0.05, 'XRP BH return');
});

check('REPRO Gold trend +32.97% -> $13,296.74', () => {
  reproduction('gold', 'trend', { final: 13296.74, ret: 32.97, dd: 12.52, trades: 12, winRate: 50.0, holding: false });
});

check('REPRO Gold mean reversion -14.84% -> $8,515.52', () => {
  reproduction('gold', 'meanReversion', { final: 8515.52, ret: -14.84, dd: 27.58, trades: 7, winRate: 66.7, holding: true });
});

check('REPRO Gold breakout +12.78% -> $11,278.19', () => {
  reproduction('gold', 'breakout', { final: 11278.19, ret: 12.78, dd: 17.73, trades: 18, winRate: 33.3, holding: false });
});

check('REPRO Gold buy-and-hold +32.10% -> $13,210.00', () => {
  const res = engine.backtest(loadAsset('gold'), 'trend');
  near(res.buyAndHold.finalEquity, 13210.0, 0.5, 'Gold BH final');
  near(res.buyAndHold.totalReturnPct, 32.1, 0.05, 'Gold BH return');
});

check('equity curves end on the reported final value', () => {
  for (const a of ['btc', 'xrp', 'gold']) {
    for (const s of ['trend', 'meanReversion', 'breakout']) {
      const res = engine.backtest(loadAsset(a), s);
      const last = res.strategyCurve[res.strategyCurve.length - 1].value;
      near(last, res.strategy.finalEquity, 0.01, a + ' ' + s + ' curve end');
      const bhLast = res.buyAndHoldCurve[res.buyAndHoldCurve.length - 1].value;
      near(bhLast, res.buyAndHold.finalEquity, 0.01, a + ' ' + s + ' BH curve end');
    }
  }
});

check('ETH and SOL run cleanly on fresh Kraken data', () => {
  for (const a of ['eth', 'sol']) {
    const bars = loadAsset(a);
    eq(bars.length, 721, a + ' bar count');
    for (const s of ['trend', 'meanReversion', 'breakout']) {
      const res = engine.backtest(bars, s);
      if (!isFinite(res.strategy.finalEquity) || res.strategy.finalEquity <= 0) {
        throw new Error(a + ' ' + s + ' produced a bad final equity: ' + res.strategy.finalEquity);
      }
    }
    console.log('    ETH/SOL note: ' + a.toUpperCase() + ' trend final = $' + engine.backtest(bars, 'trend').strategy.finalEquity);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
