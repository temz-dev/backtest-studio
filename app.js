/**
 * Backtest Studio — UI.
 *
 * Loads bundled daily candles (data/*.json) and, when live mode is on,
 * tries a live Kraken OHLC fetch first; any failure falls back to the
 * bundled data and says so. Gold has no browser-usable live endpoint
 * (Yahoo Finance blocks cross-origin reads), so Gold always uses bundled
 * data and says so.
 *
 * Runs the deterministic engine (engine.js) in the browser — the same code
 * the Node test suite checks against the verified Python results.
 */
(function () {
  'use strict';

  var BS = window.BacktestStudio;

  var ASSETS = {
    btc:  { symbol: 'BTC',  name: 'Bitcoin',  pair: 'XBTUSD', file: 'data/btc.json',  kraken: 'XBTUSD' },
    eth:  { symbol: 'ETH',  name: 'Ethereum', pair: 'ETHUSD', file: 'data/eth.json',  kraken: 'ETHUSD' },
    xrp:  { symbol: 'XRP',  name: 'XRP',      pair: 'XRPUSD', file: 'data/xrp.json',  kraken: 'XRPUSD' },
    sol:  { symbol: 'SOL',  name: 'Solana',   pair: 'SOLUSD', file: 'data/sol.json',  kraken: 'SOLUSD' },
    gold: { symbol: 'GOLD', name: 'Gold',     pair: 'GC=F',   file: 'data/gold.json', kraken: null }
  };

  var PRESETS = [
    { asset: 'btc', strategy: 'trend' },
    { asset: 'gold', strategy: 'trend' },
    { asset: 'eth', strategy: 'trend' },
    { asset: 'xrp', strategy: 'trend' }
  ];

  var state = {
    asset: 'btc',
    strategy: 'trend',
    period: '2Y',
    live: false,
    bundled: {},   // assetKey -> dataset
    liveData: {},  // assetKey -> dataset
    current: null, // active dataset {bars, source, start, end, mode}
    result: null
  };

  // --- DOM helpers ---------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function fmtPrice(x, assetKey) {
    var dp = assetKey === 'xrp' ? 4 : 2;
    return '$' + x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  }
  function fmtUnits(x) {
    return x.toLocaleString('en-US', { maximumFractionDigits: 6 });
  }
  function fmtSignedMoney(x) {
    return (x >= 0 ? '+' : '−') + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pctClass(x) { return x > 0 ? 'pos' : (x < 0 ? 'neg' : ''); }

  // --- Data loading ---------------------------------------------------------
  function loadBundled(assetKey) {
    if (state.bundled[assetKey]) return Promise.resolve(state.bundled[assetKey]);
    return fetch(ASSETS[assetKey].file).then(function (r) {
      if (!r.ok) throw new Error('bundled data missing for ' + assetKey);
      return r.json();
    }).then(function (d) {
      d.mode = 'bundled';
      state.bundled[assetKey] = d;
      return d;
    });
  }

  function fetchLive(assetKey) {
    var a = ASSETS[assetKey];
    if (!a.kraken) return Promise.reject(new Error('no live endpoint for ' + a.name));
    var url = 'https://api.kraken.com/0/public/OHLC?pair=' + a.kraken + '&interval=1440';
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 8000);
    return fetch(url, { signal: ctrl.signal }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('Kraken HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      if (d.error && d.error.length) throw new Error('Kraken: ' + d.error.join('; '));
      var key = Object.keys(d.result).filter(function (k) { return k !== 'last'; })[0];
      var bars = d.result[key].map(function (row) {
        return { t: row[0], open: +row[1], high: +row[2], low: +row[3], close: +row[4] };
      });
      if (bars.length < 100) throw new Error('too few live bars');
      var ds = {
        symbol: a.symbol, name: a.name, pair: a.pair,
        source: 'Kraken public OHLC API (live fetch)',
        fetched: new Date().toISOString(),
        start: BS.fmtDate(bars[0].t), end: BS.fmtDate(bars[bars.length - 1].t),
        bars: bars, mode: 'live'
      };
      state.liveData[assetKey] = ds;
      return ds;
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  function setStatus(text, live) {
    var n = $('data-status');
    n.textContent = text;
    n.className = 'data-status' + (live ? ' live' : '');
  }

  function useDataset(ds) {
    state.current = ds;
    setStatus(
      (ds.mode === 'live' ? '● Live data — ' : 'Bundled data — ') +
      ds.source + ' · ' + ds.start + ' to ' + ds.end + ' · ' + ds.bars.length + ' daily bars',
      ds.mode === 'live'
    );
  }

  function ensureData(assetKey) {
    // Live mode: try Kraken first, fall back to bundled with a clear label.
    if (state.live && state.liveData[assetKey]) return Promise.resolve(state.liveData[assetKey]);
    if (state.live) {
      return fetchLive(assetKey).then(function (ds) {
        useDataset(ds);
        return ds;
      }).catch(function (err) {
        return loadBundled(assetKey).then(function (ds) {
          useDataset(ds);
          setStatus('Live fetch failed (' + err.message + ') — using bundled data · ' +
            ds.start + ' to ' + ds.end + ' · ' + ds.bars.length + ' daily bars', false);
          return ds;
        });
      });
    }
    return loadBundled(assetKey).then(function (ds) {
      useDataset(ds);
      return ds;
    });
  }

  // --- Backtest + render ----------------------------------------------------
  function maxDrawdown(curve) {
    var peak = -Infinity, worst = 0;
    for (var i = 0; i < curve.length; i++) {
      if (curve[i].value > peak) peak = curve[i].value;
      var dd = peak ? (peak - curve[i].value) / peak : 0;
      if (dd > worst) worst = dd;
    }
    return worst * 100;
  }

  function run() {
    if (!state.current) return;
    var bars = BS.sliceByPeriod(state.current.bars, state.period);
    var res = BS.backtest(bars, state.strategy);
    state.result = res;
    render(res);
  }

  function render(res) {
    var a = ASSETS[state.asset];
    var strat = BS.STRATEGIES[state.strategy];
    $('result-title').textContent = a.name + ' (' + a.symbol + ') · ' + strat.name + ' · ' + state.period;

    var s = res.strategy, bh = res.buyAndHold;
    var diff = s.totalReturnPct - bh.totalReturnPct;
    var verdict = $('verdict');
    verdict.innerHTML =
      'Strategy <strong class="' + pctClass(s.totalReturnPct) + '">' + BS.fmtPct(s.totalReturnPct, true) + '</strong>' +
      ' vs buy &amp; hold <strong class="' + pctClass(bh.totalReturnPct) + '">' + BS.fmtPct(bh.totalReturnPct, true) + '</strong>' +
      ' — ' + (diff >= 0 ? 'beat' : 'trailed') + ' the benchmark by <strong class="' + pctClass(diff) + '">' +
      Math.abs(diff).toFixed(2) + 'pp</strong>';
    if (s.stillHolding) verdict.innerHTML += ' · <span title="The strategy is still holding at the end of the data.">still holding</span>';

    renderChart(res);
    $('chart-source').textContent =
      'Data: ' + state.current.source + ' · ' + state.current.start + ' to ' + state.current.end +
      ' · ' + res.bars + ' bars in this run · Start equity $10,000 · Fee 0.1% per side' +
      (state.current.mode === 'bundled' ? ' · Bundled (verified) dataset' : ' · Live dataset');

    var bhDd = maxDrawdown(res.buyAndHoldCurve);
    var stats = [
      { k: 'Total return', v: BS.fmtPct(s.totalReturnPct, true), cls: pctClass(s.totalReturnPct), s: 'vs BH ' + BS.fmtPct(bh.totalReturnPct, true) },
      { k: 'Final value', v: BS.fmtMoney(s.finalEquity), cls: '', s: 'BH ' + BS.fmtMoney(bh.finalEquity) },
      { k: 'Max drawdown', v: '−' + s.maxDrawdownPct.toFixed(2) + '%', cls: '', s: 'BH −' + bhDd.toFixed(2) + '%' },
      { k: 'Win rate', v: s.winRatePct === null ? '—' : s.winRatePct.toFixed(1) + '%', cls: '', s: s.roundTrips + ' round trips' },
      { k: 'Trades', v: String(s.trades), cls: '', s: s.roundTrips + ' buys + sells' },
      { k: 'Price move', v: BS.fmtPct((res.endClose / res.startClose - 1) * 100, true), cls: pctClass(res.endClose - res.startClose), s: fmtPrice(res.startClose, state.asset) + ' → ' + fmtPrice(res.endClose, state.asset) }
    ];
    var statsEl = $('stats');
    statsEl.innerHTML = '';
    stats.forEach(function (st) {
      var card = el('div', 'stat');
      card.appendChild(el('div', 'k', st.k));
      card.appendChild(el('div', 'v ' + st.cls, st.v));
      card.appendChild(el('div', 's', st.s));
      statsEl.appendChild(card);
    });

    var body = $('trades-body');
    body.innerHTML = '';
    var trades = res.strategyTrades;
    if (!trades.length) {
      body.appendChild(el('tr', null)).appendChild(el('td', null, 'No trades in this window.'));
    } else {
      trades.slice(-200).forEach(function (t) {
        var tr = el('tr');
        tr.appendChild(el('td', null, BS.fmtDate(t.t)));
        var side = el('td', t.type, t.type === 'buy' ? 'BUY' : 'SELL');
        tr.appendChild(side);
        tr.appendChild(el('td', null, fmtPrice(t.price, state.asset)));
        tr.appendChild(el('td', null, fmtUnits(t.units)));
        if (t.type === 'sell') {
          tr.appendChild(el('td', pctClass(t.pnl), fmtSignedMoney(t.pnl) + '  (' + BS.fmtPct(t.ret * 100, true) + ')'));
        } else {
          tr.appendChild(el('td', null, '—'));
        }
        body.appendChild(tr);
      });
    }
    $('trades-note').textContent = trades.length > 200
      ? 'Showing the most recent 200 of ' + trades.length + ' trades. P&L is net of the 0.1% fee on both sides.'
      : trades.length + ' trades in this run. P&L is net of the 0.1% fee on both sides.';
  }

  // --- SVG chart -------------------------------------------------------------
  function renderChart(res) {
    var W = 900, H = 360, PL = 72, PR = 96, PT = 18, PB = 32;
    var curves = [res.strategyCurve, res.buyAndHoldCurve];
    var min = Infinity, max = -Infinity;
    curves.forEach(function (c) {
      c.forEach(function (p) { if (p.value < min) min = p.value; if (p.value > max) max = p.value; });
    });
    var pad = (max - min) * 0.08 || 1;
    min -= pad; max += pad;
    var n = Math.max(res.strategyCurve.length, res.buyAndHoldCurve.length);
    function X(i) { return PL + (i / (n - 1)) * (W - PL - PR); }
    function Y(v) { return PT + (1 - (v - min) / (max - min)) * (H - PT - PB); }

    function points(curve) {
      return curve.map(function (p, i) { return X(i).toFixed(1) + ',' + Y(p.value).toFixed(1); }).join(' ');
    }

    var svg = [];
    svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Equity curve chart">');
    // gridlines + y labels
    for (var g = 0; g <= 4; g++) {
      var v = min + (max - min) * g / 4;
      var y = Y(v);
      svg.push('<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y.toFixed(1) + '" stroke="#1d2431" stroke-width="1"/>');
      svg.push('<text x="' + (PL - 8) + '" y="' + (y + 4).toFixed(1) + '" fill="#8b94a5" font-size="12" text-anchor="end" font-family="monospace">$' + Math.round(v).toLocaleString('en-US') + '</text>');
    }
    // start line ($10,000)
    var y0 = Y(10000);
    svg.push('<line x1="' + PL + '" y1="' + y0.toFixed(1) + '" x2="' + (W - PR) + '" y2="' + y0.toFixed(1) + '" stroke="#3a4356" stroke-width="1" stroke-dasharray="4 4"/>');
    svg.push('<text x="' + (W - PR + 6) + '" y="' + (y0 + 4).toFixed(1) + '" fill="#8b94a5" font-size="11" font-family="monospace">start $10k</text>');
    // x labels
    var first = res.strategyCurve[0], last = res.strategyCurve[res.strategyCurve.length - 1];
    var mid = res.strategyCurve[Math.floor(res.strategyCurve.length / 2)];
    svg.push('<text x="' + PL + '" y="' + (H - 10) + '" fill="#8b94a5" font-size="12" font-family="monospace">' + BS.fmtDate(first.t) + '</text>');
    svg.push('<text x="' + X(Math.floor(n / 2)).toFixed(1) + '" y="' + (H - 10) + '" fill="#8b94a5" font-size="12" text-anchor="middle" font-family="monospace">' + BS.fmtDate(mid.t) + '</text>');
    svg.push('<text x="' + (W - PR) + '" y="' + (H - 10) + '" fill="#8b94a5" font-size="12" text-anchor="end" font-family="monospace">' + BS.fmtDate(last.t) + '</text>');
    // buy & hold (grey, dashed)
    svg.push('<polyline points="' + points(res.buyAndHoldCurve) + '" fill="none" stroke="#64748b" stroke-width="2" stroke-dasharray="6 4"/>');
    // strategy (green)
    svg.push('<polyline points="' + points(res.strategyCurve) + '" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linejoin="round"/>');
    // end dots + labels (offset vertically when the two lines end close together)
    var stratEnd = res.strategyCurve[res.strategyCurve.length - 1];
    var bhEnd = res.buyAndHoldCurve[res.buyAndHoldCurve.length - 1];
    var yS = Y(stratEnd.value), yB = Y(bhEnd.value);
    var close = Math.abs(yS - yB) < 18;
    function endDot(curve, color, label, dy) {
      var p = curve[curve.length - 1];
      var x = X(curve.length - 1), y = Y(p.value);
      svg.push('<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4" fill="' + color + '"/>');
      svg.push('<text x="' + (x + 8).toFixed(1) + '" y="' + (y + dy).toFixed(1) + '" fill="' + color + '" font-size="12" font-weight="bold" font-family="monospace">' + label + '</text>');
    }
    endDot(res.strategyCurve, '#22c55e', BS.fmtMoney(res.strategy.finalEquity), close ? -10 : 4);
    endDot(res.buyAndHoldCurve, '#94a3b8', BS.fmtMoney(res.buyAndHold.finalEquity), close ? 16 : 4);
    svg.push('</svg>');
    $('chart').innerHTML = svg.join('');
  }

  // --- Presets ---------------------------------------------------------------
  function renderPresets() {
    var row = $('preset-row');
    row.innerHTML = '';
    PRESETS.forEach(function (p) {
      var a = ASSETS[p.asset];
      var btn = el('button', 'preset-btn');
      btn.setAttribute('data-asset', p.asset);
      btn.setAttribute('data-strategy', p.strategy);
      var label = a.symbol + ' · ' + BS.STRATEGIES[p.strategy].short;
      // Compute the label from the bundled dataset so it always shows the
      // verified number; live mode recomputes it when toggled.
      var ds = state.bundled[p.asset] || state.liveData[p.asset];
      if (ds) {
        try {
          var r = BS.backtest(ds.bars, p.strategy);
          var ret = r.strategy.totalReturnPct;
          label += '  ' + (ret >= 0 ? '+' : '') + ret.toFixed(1) + '%';
          btn.innerHTML = esc(label.split('  ')[0]) + '  <span class="' + pctClass(ret) + '">' + esc(label.split('  ')[1]) + '</span>';
        } catch (e) { btn.textContent = label; }
      } else {
        btn.textContent = label;
      }
      btn.addEventListener('click', function () {
        setActive('asset-row', 'asset', p.asset);
        setActive('strategy-row', 'strategy', p.strategy);
        setActive('period-row', 'period', '2Y');
        state.asset = p.asset; state.strategy = p.strategy; state.period = '2Y';
        ensureData(p.asset).then(run);
      });
      row.appendChild(btn);
    });
  }

  function setActive(rowId, attr, value) {
    var btns = $(rowId).querySelectorAll('.pick');
    btns.forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-' + attr) === value);
    });
  }

  // --- Wiring ------------------------------------------------------------------
  function bindRow(rowId, attr, key) {
    $(rowId).querySelectorAll('.pick').forEach(function (b) {
      b.addEventListener('click', function () {
        setActive(rowId, attr, b.getAttribute('data-' + attr));
        state[key] = b.getAttribute('data-' + attr);
        ensureData(state.asset).then(run);
      });
    });
  }

  function renderHow() {
    var grid = $('how-grid');
    Object.keys(BS.STRATEGIES).forEach(function (id) {
      var s = BS.STRATEGIES[id];
      var card = el('div', 'how-card');
      card.appendChild(el('h3', null, s.name));
      card.appendChild(el('p', null, s.description));
      grid.appendChild(card);
    });
  }

  $('run-btn').addEventListener('click', function () { ensureData(state.asset).then(run); });

  $('data-toggle').addEventListener('click', function () {
    state.live = !state.live;
    $('data-toggle').textContent = state.live ? 'Data: Live (Kraken)' : 'Data: Bundled (verified)';
    if (state.live && !ASSETS[state.asset].kraken) {
      setStatus('Live data is not available for Gold in the browser (Yahoo blocks cross-origin reads) — using bundled data · ' +
        state.current.start + ' to ' + state.current.end, false);
    }
    ensureData(state.asset).then(run).then(renderPresets);
  });

  bindRow('asset-row', 'asset', 'asset');
  bindRow('strategy-row', 'strategy', 'strategy');
  bindRow('period-row', 'period', 'period');

  // --- Init --------------------------------------------------------------------
  renderHow();
  var forceBundled = new URLSearchParams(window.location.search).get('data') === 'bundled';
  // Preload every bundled dataset up front so the preset labels (computed
  // from the bundled data) all show their verified returns on first paint,
  // and switching assets is instant.
  var preload = Object.keys(ASSETS).map(function (k) {
    return loadBundled(k).catch(function () { return null; });
  });
  Promise.all(preload).then(function () {
    return loadBundled('btc');
  }).then(function (ds) {
    useDataset(ds);
    renderPresets();
    run();
    // Try live data in the background (unless ?data=bundled): if Kraken
    // answers, switch to it; if not, stay on the verified bundled data.
    if (!forceBundled) {
      fetchLive('btc').then(function (live) {
        state.live = true;
        $('data-toggle').textContent = 'Data: Live (Kraken)';
        useDataset(live);
        run();
        renderPresets();
      }).catch(function () { /* stay on bundled — the status line already says so */ });
    }
  }).catch(function (e) {
    setStatus('Could not load bundled data: ' + e.message, false);
  });
})();
