'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  http = require('node:http'),
  path = require('node:path');
const { chromium } = require('playwright');
const { getOverview } = require('../../widgets/energy-overview/api');
const { tariffKey, currentMonth } = require('../../lib/tariff-config');
const directory = path.join(__dirname, '../../widgets/energy-overview/public');
let mode = 'meter';
const NOW = Date.parse('2026-11-12T12:00Z');
function values() {
  const now = NOW,
    tariff = {
      start: '07:00',
      end: '20:00',
      weekdays: [1, 2, 3, 4, 5],
      peakCount: 5,
      distinctDays: true,
      rateSekPerKw: 100,
    };
  const result = {
    month: currentMonth(new Date(now)),
    tariffKey: tariffKey(tariff),
    status: 'provisional',
    averageKw: 4.2,
    estimatedSek: 420,
    coverage: {
      expectedHours: 200,
      elapsedHours: 100,
      completeHours: 80,
      missingHours: 20,
      pendingHours: 100,
    },
    fetchedAt: new Date(now - 3600000).toISOString(),
  };
  return {
    sourceConfig: {
      tibber: { revision: 'synthetic' },
      sigenergy: { configured: true, enabled: true, since: new Date(now - 3600000).toISOString() },
    },
    sigenergyStatus: { readAt: new Date(now).toISOString() },
    historyState: {
      schema: 3,
      slots: [
        {
          t: Math.floor(now / 900000) * 900000,
          counts: { gridW: 1, pvW: 1, soc: 1, essW: 1 },
          sum: { gridW: 2000, pvW: 500, soc: 70, essW: 1000 },
        },
      ],
    },
    demandTariff: mode === 'no-tariff' ? null : tariff,
    tibberConsumptionArchive: { configRevision: 'synthetic' },
    meterDemandEstimate: ['local', 'partial-local'].includes(mode)
      ? null
      : { ...result, ...(mode === 'stale' ? { month: '2000-01' } : {}) },
    demandEstimate:
      mode === 'local'
        ? { ...result, averageKw: 3, estimatedSek: 300 }
        : {
            ...result,
            status: 'insufficient-data',
            averageKw: null,
            estimatedSek: null,
            selectedPeaks: [3, 2, 1].map((kw, i) => ({
              kw,
              t: Date.parse('2026-11-' + String(9 + i).padStart(2, '0') + 'T09:00Z'),
            })),
          },
    tariffOptimization: { status: 'insufficient-data' },
  };
}
const server = http.createServer((req, res) => {
  if (req.url === '/homey.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(
      `window.Homey={api:(method,p)=>{if(method!=='GET'||p!=='/')throw Error('Unexpected API');return fetch('/snapshot').then(r=>{if(!r.ok)throw Error('Read failed');return r.json();});},ready:()=>window.appReady=true,setHeight:h=>window.widgetHeight=h};document.addEventListener('DOMContentLoaded',()=>onHomeyReady(Homey));`,
    );
    return;
  }
  if (req.url === '/snapshot') {
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'failure') {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'PRIVATE_FAILURE' }));
      return;
    }
    const data = values(),
      before = JSON.stringify(data);
    const result = getOverview(
      {
        homey: {
          settings: {
            get: (k) => data[k],
            set: () => {
              throw Error('Writes forbidden');
            },
          },
        },
      },
      NOW,
    );
    assert.equal(JSON.stringify(data), before);
    res.end(JSON.stringify(result));
    return;
  }
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!/^[\w.-]+$/.test(name)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/html');
    res.end(fs.readFileSync(path.join(directory, name)));
  } catch {
    res.writeHead(404).end();
  }
});
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.addInitScript(
      ({ now }) => {
        const OriginalDate = Date;
        globalThis.Date = class extends OriginalDate {
          constructor(...args) {
            super(...(args.length ? args : [now]));
          }
          static now() {
            return now;
          }
        };
      },
      { now: NOW },
    );
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const [width, scheme] of [
      [320, 'light'],
      [390, 'dark'],
      [1100, 'light'],
      [1100, 'dark'],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      for (const scenario of ['meter', 'local', 'partial-local', 'stale', 'no-tariff', 'failure']) {
        mode = scenario;
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(() => window.appReady);
        const source = await page.locator('#monthlySource').textContent();
        if (mode === 'meter') {
          assert.match(source, /Tibber/);
          assert.equal(await page.locator('#meterSek').textContent(), '420 kr');
          assert.equal(await page.locator('#demandSek').textContent(), '–');
          assert.equal(await page.locator('#demandKw').textContent(), '2 kW');
          assert.equal(await page.locator('#simSaving').textContent(), '–');
          assert.match(await page.locator('#demandState').textContent(), /3 av 5 olika mätdagar/);
          const monthly = await page.locator('#monthly-demand').boundingBox();
          const recommendation = await page
            .getByText('Rekommenderade inställningar', { exact: true })
            .boundingBox();
          assert.ok(monthly.y < recommendation.y, 'monthly amount precedes recommendations');
          if (process.env.SETTINGS_SCREENSHOTS) {
            fs.mkdirSync(process.env.SETTINGS_SCREENSHOTS, { recursive: true });
            await page.screenshot({
              path: path.join(process.env.SETTINGS_SCREENSHOTS, `demand-${width}-${scheme}.png`),
              fullPage: true,
            });
          }
        } else if (mode === 'local') {
          assert.match(source, /Sigenergy/);
          assert.equal(await page.locator('#meterSek').textContent(), '300 kr');
          assert.match(await page.locator('#meterState').textContent(), /lokal avgift/);
        } else if (mode === 'partial-local') {
          assert.equal(await page.locator('#meterKw').textContent(), '2 kW');
          assert.equal(await page.locator('#meterSek').textContent(), '–');
          assert.match(
            await page.locator('#meterPeakLabel').textContent(),
            /Medel hittills \(3 av 5\)/,
          );
          await page.getByText('Visa toppar hittills', { exact: true }).click();
          assert.match(await page.locator('#meterPeaks').textContent(), /3 kW/);
        } else {
          assert.equal(await page.locator('#meterSek').textContent(), '–');
          assert.doesNotMatch(source, /Tibber – mätarreferens/);
        }
        await page.locator('details').evaluateAll((ds) => ds.forEach((d) => (d.open = true)));
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        );
        assert.doesNotMatch(await page.locator('body').textContent(), /PRIVATE_FAILURE/);
      }
      mode = 'meter';
      await page.reload();
      await page.waitForFunction(() => window.appReady);
      await page.addStyleTag({ content: 'body {font-size:20px}' });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    assert.deepEqual(errors, []);
    console.log(
      'Energy overview browser checks passed: monthly source priority, distinct-day explanation, local fallback, stale/error/absent data, phone/desktop, large text and light/dark.',
    );
  } finally {
    await browser?.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
