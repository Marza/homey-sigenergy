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
  f.data.sourceConfig.household = { configured: true, enabled: true };
  f.data.householdCounterStatus = {
    readAt: new Date().toISOString(),
    totalKWh: 123.45,
    averageKW: 0,
  };
  const at = Date.now();
  f.data.gridPhaseCurrent = { state: 'ok', at, amps: [23.5, 5, 0], maxAgeMs: 30000 };
  f.data.inverterPhaseCurrent = { state: 'ok', at: at - 60000, amps: [2, 3, 4], maxAgeMs: 30000 };
  f.rows[6].phaseCurrent = {
    grid: {
      binding: 'a'.repeat(24),
      ms: 900000,
      ampMs: [8100000, 4500000, 0],
      peakA: [23.5, 5, 0],
    },
  };
  f.rows[0].coverageMs = 0;
  f.rows[0].directionalCoverageMs = 0;
  f.rows[0].gridWh = 0;
  f.rows[0].importWh = 0;
  const boundary = f.rows[1].t;
  const allocation = {
    method: 'missing-time-proportional',
    from: boundary - 60000,
    to: boundary + 60000,
    missingMs: [60000, 60000],
    correctionWh: { gridWh: 120, importWh: 120, exportWh: 0 },
  };
  f.rows[1].coverageMs -= 60000;
  f.rows[1].directionalCoverageMs -= 60000;
  for (let i = 0; i < 2; i++) {
    const part = {
      from: i ? boundary : boundary - 60000,
      to: i ? boundary + 60000 : boundary,
      coverageMs: 60000,
      correctionWh: { gridWh: 60, importWh: 60, exportWh: 0 },
      maxCollectionSkewMs: 2000,
      allocation,
    };
    const aggregate = { ...part };
    delete aggregate.allocation;
    f.rows[i].counterRecovery = { grid: { ...aggregate, parts: [part] } };
  }
  f.data.tibberHistoryPriceCache.networkEnergy = [{ t: f.rows[0].t, importWh: 1000, exportWh: 0 }];
  f.rows[2].essCoverageMs = 0;
  f.rows[4].fieldCoverageMs.pvW = 0;
  f.rows[5].fieldCoverageMs.evW = 0;
  Object.assign(f.rows[6], {
    householdWh: 1250,
    householdCoverageMs: 900000,
    householdEstimatedMs: 60000,
  });
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
      await page.locator('#tab-diagnostics').click();
      await page
        .locator('#diagnosticRows')
        .getByText(/Räknarställning 123,45 kWh/)
        .waitFor();
      assert.match(
        await page.locator('#diagnosticRows').textContent(),
        /Medel sedan förra avläsningen 0 kW/,
      );
      await page.locator('#gridPhaseStatus').getByText('L1 23,5 A · L2 5 A · L3 0 A').waitFor();
      await page.locator('#inverterPhaseStatus').getByText('Mätvärdena är inaktuella.').waitFor();
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
      assert.match(text, /Kvart med räknaråterhämtning: 2/);
      assert.match(text, /Säljpriser/);
      assert.match(text, /Kvart med fördelning över kvartgräns: 2/);
      assert.match(text, /exakta energifördelningen.*okänd/);
      assert.match(text, /Observerat: 23 h 44 min/);
      assert.match(text, /Räknarestimat: 2 min/);
      assert.match(text, /Okänd tid: 14 min/);
      assert.match(text, /Enbart observerade Sigenergy-kvart: 23 timmar/);
      assert.match(text, /Okända timmar: 0/);
      assert.match(text, /Bil \(EVDC\)/);
      assert.match(text, /AC-laddare \(EVAC\)/);
      assert.match(text, /Husets förbrukning utan billaddning/);
      assert.match(text, /Energi under täckt tid: 1,25 kWh/);
      assert.match(text, /Sparad fasström vid nätanslutningen/);
      assert.match(text, /Hela mätkvartar 1/);
      assert.match(text, /L1 · Medel 9 A · Topp 23,5 A/);
      assert.match(text, /Sparad fasström vid växelriktaren/);
      assert.match(text, /Fasström saknas för vald period/);
      assert.equal(await page.locator('.coverage-bar').count(), 6);
      const bars = await page.locator('.coverage-bar').evaluateAll((bs) =>
        bs.map((b) => ({
          width: b.getBoundingClientRect().width,
          sum: [...b.children].reduce((n, c) => n + c.getBoundingClientRect().width, 0),
          colors: [...b.children].map((c) => getComputedStyle(c).backgroundColor),
          hidden: b.getAttribute('aria-hidden'),
        })),
      );
      for (const bar of bars) {
        assert.ok(bar.width > 0 && Math.abs(bar.width - bar.sum) < 1);
        assert.equal(new Set(bar.colors).size, 3);
        assert.equal(bar.hidden, 'true');
      }
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
      await page.locator('#gap-refresh').click();
      await page.waitForFunction(() =>
        document.getElementById('gap-status').textContent.startsWith('Diagnostik hämtad'),
      );
      assert.match(await page.locator('#gap-results').textContent(), /Totalt 72 avslutade timmar/);
      assert.match(await page.locator('#gap-results').textContent(), /Okänd tid: 48 h 14 min/);
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
