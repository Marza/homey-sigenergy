'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  http = require('node:http'),
  path = require('node:path');
const { chromium } = require('playwright');
const { fixture } = require('../fixtures/readiness.cjs');
const { DataDiagnostics } = require('../../lib/data-diagnostics');
const api = require('../../api');
let f,
  mode = 'normal',
  delay = 0,
  diagnosticCalls = 0;
function reset() {
  f = fixture({ hours: 24, now: Math.floor(Date.now() / 3600000) * 3600000 });
  f.homey.app.dataDiagnostics = new DataDiagnostics(f.homey.settings, () => f.now);
  f.rows[0].coverageMs = 0;
  f.rows[0].directionalCoverageMs = 0;
  f.rows[0].gridWh = 0;
  f.rows[0].importWh = 0;
  f.rows[0].counterRecovery = {
    grid: {
      from: f.rows[0].t + 60000,
      to: f.rows[0].t + 180000,
      coverageMs: 120000,
      correctionWh: { gridWh: 120, importWh: 120, exportWh: 0 },
      maxCollectionSkewMs: 2000,
    },
  };
  f.data.tibberHistoryPriceCache.networkEnergy = [{ t: f.rows[0].t, importWh: 1000, exportWh: 0 }];
  f.rows[2].essCoverageMs = 0;
  f.rows[4].fieldCoverageMs.pvW = 0;
  delete f.data.tibberHistoryPriceCache.rows[1].production;
  f.homey.app.dataDiagnostics.record('grid', 'modbus-timeout', f.rows[0].t, f.rows[0].t + 10000);
  mode = 'normal';
  delay = 0;
}
reset();
const hostCss = fs.readFileSync(
  process.env.SETTINGS_HOST_CSS || path.join(__dirname, '../fixtures/settings-host-reset.css'),
);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/homey.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(
      `window.Homey={get:(key,cb)=>fetch('/setting/'+key).then(r=>r.json()).then(v=>cb(null,v)).catch(cb),set:()=>{throw Error('No writes allowed');},api:(method,path,body,cb)=>fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})}).then(r=>r.json()).then(v=>v.error?cb(Error(v.error)):cb(null,v)).catch(cb),ready:()=>window.appReady=true};document.addEventListener('DOMContentLoaded',()=>{const css=document.createElement('link');css.rel='stylesheet';css.href='/host.css';css.onload=()=>onHomeyReady(Homey);document.head.appendChild(css);});`,
    );
    return;
  }
  if (url.pathname === '/host.css') {
    res.setHeader('Content-Type', 'text/css');
    res.end(hostCss);
    return;
  }
  if (url.pathname.startsWith('/setting/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(f.data[url.pathname.slice(9)] ?? null));
    return;
  }
  if (url.pathname.startsWith('/api')) {
    res.setHeader('Content-Type', 'application/json');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (url.pathname !== '/api/diagnostics/data-gaps') {
        res.end(JSON.stringify({ error: 'Synthetic unavailable data' }));
        return;
      }
      diagnosticCalls++;
      const before = JSON.stringify(f.data);
      let result;
      if (mode === 'error') result = { error: 'PRIVATE_ERROR_TOKEN' };
      else if (mode === 'malformed') result = { schema: 1 };
      else result = await api.getDataDiagnostics({ homey: f.homey, body: JSON.parse(body) });
      assert.equal(JSON.stringify(f.data), before, 'diagnostic reads must not write settings');
      setTimeout(() => res.end(JSON.stringify(result)), delay);
    });
    return;
  }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!/^[\w.-]+$/.test(name)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader(
      'Content-Type',
      name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    );
    res.end(fs.readFileSync(path.join(__dirname, '../../settings', name)));
  } catch {
    res.writeHead(404).end();
  }
});
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const [width, scheme] of [
      [320, 'light'],
      [390, 'dark'],
      [1100, 'light'],
      [1100, 'dark'],
    ]) {
      reset();
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => window.appReady);
      await page.locator('#tab-settings').click();
      if (width < 768) await page.locator('#settingsCategory').selectOption('data');
      else await page.locator('[data-settings-category="data"]').click();
      const initialCalls = diagnosticCalls;
      await page.locator('#gap-refresh').click();
      await page.waitForFunction(() =>
        document.getElementById('gap-status').textContent.startsWith('Diagnostik hämtad'),
      );
      assert.equal(diagnosticCalls, initialCalls + 1);
      const text = await page.locator('#gap-results').textContent();
      assert.match(text, /Modbus svarade inte i tid/);
      assert.match(text, /Ingen orsak registrerad/);
      assert.match(text, /Köppriser/);
      assert.match(text, /Timmar kompletterade från Tibber: 1/);
      assert.match(text, /Kvart med räknaråterhämtning: 1/);
      assert.match(text, /Säljpriser/);
      assert.match(text, /1 saknade eller ofullständiga hela timmar/);
      assert.doesNotMatch(text, /PRIVATE|SECRET|Bearer|unitPrice/);
      await page
        .locator('#gap-results details')
        .evaluateAll((ds) => ds.forEach((d) => (d.open = true)));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (process.env.SETTINGS_SCREENSHOTS) {
        fs.mkdirSync(process.env.SETTINGS_SCREENSHOTS, { recursive: true });
        await page.locator('#dataDiagnosticsPanel').screenshot({
          path: path.join(process.env.SETTINGS_SCREENSHOTS, `gaps-${width}-${scheme}.png`),
        });
      }
      await page.locator('#gap-hours').selectOption('72');
      assert.equal(await page.locator('#gap-results').textContent(), '');
      mode = 'malformed';
      await page.locator('#gap-refresh').click();
      await page.waitForFunction(() =>
        document.getElementById('gap-status').textContent.startsWith('Diagnostiken kunde inte'),
      );
      assert.equal(await page.locator('#gap-results').textContent(), '');
      mode = 'error';
      await page.locator('#gap-refresh').click();
      await page.waitForFunction(() => !document.getElementById('gap-refresh').disabled);
      assert.doesNotMatch(await page.locator('#gap-status').textContent(), /PRIVATE/);
      mode = 'normal';
      delay = 250;
      await page.locator('#gap-refresh').click();
      await page.locator('#gap-hours').selectOption('24');
      await page.waitForTimeout(350);
      assert.equal(await page.locator('#gap-results').textContent(), '');
    }
    assert.deepEqual(errors, []);
    console.log(
      'Data-gap diagnostics browser checks passed: real read-only endpoint, classified/unknown causes, source-specific gaps, late/error/malformed responses, phone/desktop, light/dark and no overflow.',
    );
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
