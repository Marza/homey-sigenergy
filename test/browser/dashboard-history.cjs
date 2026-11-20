'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { SLOT_MS: Q, dayBounds } = require('../../lib/history-format');
const widgets = {
  'energy-flow': require('../../widgets/energy-flow/api'),
  'power-history': require('../../widgets/power-history/api'),
};
const day = '2026-06-18';
const { start } = dayBounds(day);
const now = start + 89 * Q;
const rows = [];
for (const offset of [-96, 0]) {
  for (let i = 0; i < 89; i++) {
    if (i === 30 || i === 31) continue;
    const beforeSun = i < 28;
    const dcW = i < 10 ? 14300 : 0;
    const acW = i > 70 && i < 76 ? 1800 : 0;
    const gridW = beforeSun ? (i < 10 ? 17000 : 3200) : Math.round(2700 * Math.cos((i - 29) / 9));
    const solarW = Math.max(0, Math.round(6300 * Math.sin((i - 21) / 16)));
    const batteryW = beforeSun ? (i < 10 ? 0 : 4800) : Math.round(1900 * Math.sin(i / 6));
    const houseW = 2100 + Math.round(580 * Math.cos(i * 0.66));
    rows.push({
      t: start + (offset + i) * Q,
      schema: 2,
      coverageMs: Q,
      directionalCoverageMs: Q,
      essCoverageMs: Q,
      fieldCoverageMs: { pvW: Q, evW: Q, ...(i === 53 ? {} : { evacW: Q }) },
      gridWh: gridW / 4,
      importWh: Math.max(0, gridW) / 4,
      exportWh: Math.max(0, -gridW) / 4,
      pvWh: solarW / 4,
      essWh: batteryW / 4,
      evWh: dcW / 4,
      evacWh: acW / 4,
      householdWh: houseW / 4,
      householdCoverageMs: Q,
      householdEstimatedMs: i === 40 ? 1000 : 0,
    });
  }
}
let fail = false;
const server = http.createServer((req, res) => {
  const [widget, ...rest] = new URL(req.url, 'http://localhost').pathname
    .split('/')
    .filter(Boolean);
  if (!Object.hasOwn(widgets, widget)) return res.writeHead(404).end();
  if (rest[0] === 'api') {
    const [date, period] = rest.slice(1);
    const homey = { app: { history: { getEnergySlots: () => rows } } };
    return res
      .writeHead(fail ? 500 : 200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(widgets[widget].getHistory({ homey, params: { date, period } }, now)));
  }
  const filename = rest[0] || 'index.html';
  if (!/^[a-z.-]+$/.test(filename)) return res.writeHead(404).end();
  try {
    const source = fs.readFileSync(
      path.join(__dirname, '../../widgets', widget, 'public', filename),
      'utf8',
    );
    if (filename === 'index.html') {
      const host = `<script>document.addEventListener('DOMContentLoaded', () => {
        onHomeyReady({ ready: () => window.widgetReady = true, setHeight: (height) => window.lastHeight = height,
          api: (method, path) => fetch('/${widget}/api'+path, {method}).then(r=>{if(!r.ok)throw Error('offline'); return r.json()}) });
      });</script>`;
      return res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(source.replace('</body>', host + '</body>'));
    }
    return res
      .writeHead(200, {
        'Content-Type': filename.endsWith('.css') ? 'text/css' : 'text/javascript',
      })
      .end(source);
  } catch {
    return res.writeHead(404).end();
  }
});

async function run() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch();
    for (const [width, mode] of [
      [320, 'light'],
      [400, 'light'],
      [400, 'dark'],
    ]) {
      for (const widget of Object.keys(widgets)) {
        fail = false;
        const page = await browser.newPage({
          viewport: { width, height: 850 },
          colorScheme: mode,
          reducedMotion: 'reduce',
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/${widget}/`);
        const content = page.locator('#history-results');
        await content.waitFor({ state: 'visible' });
        await page.waitForFunction(() => window.widgetReady && window.lastHeight > 100);
        assert.equal(await page.locator('#history-date').inputValue(), day);
        assert.equal(await page.locator('#history-next').isDisabled(), true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(
          await page.locator('canvas').evaluate((canvas) => getComputedStyle(canvas).touchAction),
          'pan-y',
        );
        await page.waitForFunction(() => document.documentElement.dataset.widgetFits === 'true');
        await page.waitForFunction(() => {
          const canvas = document.querySelector('canvas');
          return canvas
            .getContext('2d')
            .getImageData(0, 0, canvas.width, canvas.height)
            .data.some((value) => value > 0);
        });
        if (process.env.WRITE_HISTORY_WIDGET_PREVIEWS === '1' && width === 400) {
          await page.addStyleTag({
            content: mode === 'dark' ? 'html{background:#161e27}' : 'html{background:#fff}',
          });
          await page.locator('main').screenshot({
            path: path.join(__dirname, '../../widgets', widget, `preview-${mode}.png`),
            animations: 'disabled',
          });
        }
        await page.locator('#history-back').click();
        await page.waitForFunction(
          () => document.querySelector('#history-date').value === '2026-06-17',
        );
        await content.waitFor({ state: 'visible' });
        if (widget === 'energy-flow') {
          assert.match(await page.locator('#energy-into').innerText(), /Solproduktion/);
          assert.match(await page.locator('#energy-out').innerText(), /Hus utan billaddning/);
          assert.match(await page.locator('#energy-out').innerText(), /86 av 96 kvart/);
          await page.locator('#history-period').selectOption('week');
          await content.waitFor({ state: 'visible' });
          assert.match(await page.locator('#flow-coverage').innerText(), /377 avslutade kvart/);
          await page.locator('#history-period').selectOption('month');
          await content.waitFor({ state: 'visible' });
          assert.match(await page.locator('#flow-coverage').innerText(), /1721 avslutade kvart/);
          await page.locator('#history-period').selectOption('day');
          await content.waitFor({ state: 'visible' });
        } else {
          const slider = page.locator('#chart-quarter');
          await slider.fill('0');
          assert.match(await page.locator('#chart-readings').innerText(), /Nät 17 kW/);
          assert.match(await page.locator('#chart-readings').innerText(), /DC-laddare −14,3 kW/);
          await slider.fill('30');
          assert.match(await page.locator('#chart-readings').innerText(), /Nät –/);
          const grid = page.getByRole('button', { name: 'Nät', exact: true });
          await grid.click();
          assert.equal(await grid.getAttribute('aria-pressed'), 'false');
          assert.doesNotMatch(await page.locator('#chart-readings').innerText(), /Nät/);
        }
        fail = true;
        await page.locator('#history-next').click();
        await page.getByText('Historiken kunde inte hämtas.').waitFor();
        assert.equal(await content.isHidden(), true);
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
    console.log(
      'History widgets passed: local history APIs, dates, gaps, series controls, light/dark and phone width.',
    );
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
