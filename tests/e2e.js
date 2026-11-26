'use strict';
/* Backtest Studio e2e tests (Playwright headless Chromium).
 * Run:  node tests/e2e.js
 * Serves the app on a local port, loads it, runs a backtest for each
 * strategy on BTC, checks the results render and the chart draws, and
 * takes screenshots into screenshots/. Exits 0 when every case passes.
 *
 * Note: the app attempts a live Kraken fetch on a normal load; in this
 * sandbox that request fails (proxy tunnel). Those network errors are
 * expected and filtered out. Deterministic assertions use ?data=bundled,
 * which skips the live attempt entirely.
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var root = path.resolve(__dirname, '..');

var playwright;
try {
  playwright = require('../node_modules/playwright');
} catch (e) {
  playwright = require('/home/hatch/workspace/kiroween-crypto-graveyard/node_modules/playwright');
}

function startServer(port) {
  return new Promise(function (resolve, reject) {
    var srv = http.createServer(function (req, res) {
      var pathname = req.url.split('?')[0];
      var rel = pathname === '/' ? '/index.html' : pathname;
      var file = path.join(root, rel);
      fs.readFile(file, function (err, data) {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        var ext = path.extname(file);
        var mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' }[ext] || 'text/plain';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      });
    });
    srv.listen(port, '127.0.0.1', function () { resolve(srv); });
    srv.on('error', reject);
  });
}

var passed = 0, failed = 0;
function check(desc, cond, extra) {
  if (cond) { console.log('  PASS  ' + desc); passed++; }
  else { console.error('  FAIL  ' + desc + (extra ? ' — ' + extra : '')); failed++; }
}

function isAllowedNetErr(txt) {
  if (txt.indexOf('ERR_TUNNEL_CONNECTION_FAILED') !== -1) return true;
  if (txt.indexOf('ERR_NAME_NOT_RESOLVED') !== -1) return true;
  if (txt.indexOf('ERR_NETWORK_CHANGED') !== -1) return true;
  if (txt.indexOf('net::ERR_') !== -1 && txt.indexOf('Failed to load resource') !== -1) return true;
  return false;
}

async function text(page, sel) {
  var h = await page.$(sel);
  return h ? (await h.textContent()) : null;
}

async function run() {
  var port = 18375;
  var server = await startServer(port);
  var base = 'http://127.0.0.1:' + port;
  var browser = await playwright.chromium.launch({ headless: true });
  var context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  var page = await context.newPage();
  var consoleErrors = [], pageErrors = [];
  page.on('console', function (msg) {
    if (msg.type() === 'error' && !isAllowedNetErr(msg.text())) consoleErrors.push(msg.text());
  });
  page.on('pageerror', function (err) { pageErrors.push(err.message); });

  var shotDir = path.join(root, 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });

  // --- Default load: bundled BTC trend renders ---------------------------
  await page.goto(base + '/?data=bundled', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('#stats .stat', { timeout: 10000 });
  await page.waitForTimeout(500);

  check('page title', (await page.title()).indexOf('Backtest Studio') !== -1);
  check('result title shows BTC Trend', (await text(page, '#result-title') || '').indexOf('Bitcoin') !== -1 &&
    (await text(page, '#result-title')).indexOf('Trend') !== -1);
  check('verdict mentions buy & hold', (await text(page, '#verdict') || '').indexOf('buy & hold') !== -1);
  check('chart SVG drawn with two polylines', (await page.$$('#chart svg polyline')).length === 2);
  check('six stat cards render', (await page.$$('#stats .stat')).length === 6);
  var statsText = await text(page, '#stats');
  check('BTC Trend return is +16.37%', statsText.indexOf('+16.37%') !== -1, statsText);
  check('BTC Trend final value is $11,636.99', statsText.indexOf('$11,636.99') !== -1, statsText);
  check('trades table has rows', (await page.$$('#trades-body tr')).length > 10);
  check('data source line names the bundled dataset', (await text(page, '#chart-source') || '').indexOf('Bundled (verified)') !== -1);
  await page.screenshot({ path: path.join(shotDir, '01-landing-btc-trend.png') });

  // --- Mean reversion on BTC ----------------------------------------------
  await page.click('#strategy-row [data-strategy="meanReversion"]');
  await page.waitForTimeout(400);
  statsText = await text(page, '#stats');
  check('BTC mean reversion return is -32.27%', statsText.indexOf('-32.27%') !== -1, statsText);
  check('BTC mean reversion final value is $6,772.74', statsText.indexOf('$6,772.74') !== -1, statsText);
  await page.screenshot({ path: path.join(shotDir, '02-btc-mean-reversion.png') });

  // --- Breakout on BTC ------------------------------------------------------
  await page.click('#strategy-row [data-strategy="breakout"]');
  await page.waitForTimeout(400);
  statsText = await text(page, '#stats');
  check('BTC breakout return is -23.57%', statsText.indexOf('-23.57%') !== -1, statsText);

  // --- Gold preset ----------------------------------------------------------
  await page.click('#preset-row [data-asset="gold"]');
  await page.waitForTimeout(600);
  statsText = await text(page, '#stats');
  check('Gold Trend return is +32.97%', statsText.indexOf('+32.97%') !== -1, statsText);
  check('Gold Trend final value is $13,296.74', statsText.indexOf('$13,296.74') !== -1, statsText);
  check('result title switched to Gold', (await text(page, '#result-title') || '').indexOf('Gold') !== -1);
  await page.screenshot({ path: path.join(shotDir, '03-gold-trend.png') });

  // --- Period picker ---------------------------------------------------------
  await page.click('#period-row [data-period="6M"]');
  await page.waitForTimeout(400);
  check('6M period still renders a chart', (await page.$$('#chart svg polyline')).length === 2);
  check('6M period title shows 6M', (await text(page, '#result-title') || '').indexOf('6M') !== -1);
  await page.click('#period-row [data-period="2Y"]');
  await page.waitForTimeout(400);

  // --- Live-mode fallback: default load (live attempt fails in sandbox) ------
  var page2 = await context.newPage();
  var fallbackOk = false;
  page2.on('console', function () { /* ignore */ });
  await page2.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page2.waitForSelector('#stats .stat', { timeout: 10000 });
  await page2.waitForTimeout(2500);
  var status2 = await text(page2, '#data-status');
  fallbackOk = (status2 || '').indexOf('Bundled data') !== -1;
  check('live attempt falls back to bundled data in sandbox', fallbackOk, status2);
  var stats2 = await text(page2, '#stats');
  check('fallback run still shows BTC Trend +16.37%', (stats2 || '').indexOf('+16.37%') !== -1, stats2);
  await page2.close();

  // --- Mobile 360px -----------------------------------------------------------
  var mContext = await browser.newContext({ viewport: { width: 360, height: 800 } });
  var mPage = await mContext.newPage();
  mPage.on('pageerror', function (err) { pageErrors.push('mobile: ' + err.message); });
  await mPage.goto(base + '/?data=bundled', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await mPage.waitForSelector('#stats .stat', { timeout: 10000 });
  await mPage.waitForTimeout(500);
  var overflow = await mPage.evaluate(function () { return document.documentElement.scrollWidth - document.documentElement.clientWidth; });
  check('mobile 360px: no horizontal overflow', overflow <= 0, 'overflow ' + overflow + 'px');
  check('mobile chart still draws', (await mPage.$$('#chart svg polyline')).length === 2);
  await mPage.screenshot({ path: path.join(shotDir, '04-mobile-360.png') });
  await mContext.close();

  // --- Errors ------------------------------------------------------------------
  check('zero console errors (excluding expected network failures)', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 500));
  check('zero page errors', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 500));

  await browser.close();
  server.close();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch(function (e) { console.error('E2E CRASH: ' + (e && e.stack || e)); process.exit(1); });
