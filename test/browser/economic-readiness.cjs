'use strict';
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  http = require('node:http'),
  path = require('node:path');
const { chromium } = require('playwright');
const { fixture } = require('../fixtures/readiness.cjs');
const { checkReadiness } = require('../../lib/pricing/comparison-readiness');
const root = path.resolve(__dirname, '../..');
let f,
  mode = 'normal',
  posts = 0,
  delay = 0;
const hostCss = fs.readFileSync(
  process.env.SETTINGS_HOST_CSS || path.join(__dirname, '../fixtures/settings-host-reset.css'),
);
function reset() {
  f = fixture({ now: Date.now() });
  mode = 'normal';
  posts = 0;
  delay = 0;
}
reset();
const server = http.createServer((req, res) => {
  if (req.url === '/homey.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(
      `window.Homey={get:(key,cb)=>fetch('/setting/'+key).then(r=>r.json()).then(v=>cb(null,v)).catch(cb),set:()=>{throw Error('No settings writes allowed');},api:(method,path,body,cb)=>fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})}).then(r=>r.json()).then(v=>v.error?cb(Error(v.error)):cb(null,v)).catch(cb),ready:()=>window.appReady=true};document.addEventListener('DOMContentLoaded',()=>{const css=document.createElement('link');css.rel='stylesheet';css.href='/host.css';css.onload=()=>onHomeyReady(Homey);document.head.appendChild(css);});`,
    );
    return;
  }
  if (req.url === '/host.css') {
    res.setHeader('Content-Type', 'text/css');
    res.end(hostCss);
    return;
  }
  if (req.url.startsWith('/setting/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(f.data[req.url.slice(9)] ?? null));
    return;
  }
  if (req.url.startsWith('/api')) {
    res.setHeader('Content-Type', 'application/json');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url !== '/api/economics/readiness') {
        res.end(JSON.stringify({ error: 'Synthetic unavailable data' }));
        return;
      }
      posts++;
      const before = JSON.stringify({ data: f.data, rows: f.rows });
      let result;
      if (mode === 'failure') result = { error: 'Synthetic private failure' };
      else if (mode === 'malformed') result = { status: 'complete', dataComplete: true };
      else result = checkReadiness(f.homey, JSON.parse(body), f.now);
      assert.equal(
        JSON.stringify({ data: f.data, rows: f.rows }),
        before,
        'inspection must not mutate history/settings',
      );
      setTimeout(() => res.end(JSON.stringify(result)), delay);
    });
    return;
  }
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!/^[\w.-]+$/.test(name)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader(
      'Content-Type',
      name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    );
    res.end(fs.readFileSync(path.join(root, 'settings', name)));
  } catch {
    res.writeHead(404).end();
  }
});
(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch({
      ...(process.env.SETTINGS_CHROMIUM ? { executablePath: process.env.SETTINGS_CHROMIUM } : {}),
    });
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const [width, scheme] of [
      [390, 'light'],
      [1100, 'dark'],
    ]) {
      reset();
      await page.setViewportSize({ width, height: 1100 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => window.appReady);
      assert.equal(posts, 0);
      await page.locator('#tab-settings').click();
      if (width < 768) await page.locator('#settingsCategory').selectOption('economics');
      else await page.locator('[data-settings-category="economics"]').click();
      await page
        .locator('#economicScenarioPanel')
        .evaluate((e) => (e.closest('details').open = true));
      await page.locator('#econ-hours').fill('4');
      const button = page.locator('#econ-check-data'),
        status = page.locator('#econ-data-status'),
        list = page.locator('#econ-data-checks');
      await button.click();
      await page.waitForFunction(() =>
        document
          .querySelector('#econ-data-status')
          .textContent.includes('Data för grundkontrollen är täckta'),
      );
      assert.equal(await list.locator(':scope > li').count(), 9);
      assert.equal(posts, 1);
      assert.equal(await page.locator('#econ-model-confirm').isChecked(), false);
      assert.equal(await page.locator('#econ-date-confirm').isChecked(), false);
      f.rows.splice(1, 2);
      delete f.data.costContractTimeline;
      f.data.tibberHistoryPriceCache.rows[1].production = null;
      await button.click();
      await page.waitForFunction(() =>
        document.querySelector('#econ-data-status').textContent.includes('ofullständigt'),
      );
      assert.match(await list.innerText(), /2 kvart saknas/);
      assert.match(await list.innerText(), /4 kvart saknas/);
      assert.match(await list.innerText(), /16 kvart saknas/);
      await list.locator('summary').first().click();
      assert.match(await list.innerText(), /GMT/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (process.env.SETTINGS_SCREENSHOTS) {
        fs.mkdirSync(process.env.SETTINGS_SCREENSHOTS, { recursive: true });
        await page.locator('#econ-readiness-panel').screenshot({
          path: path.join(process.env.SETTINGS_SCREENSHOTS, `readiness-${width}-${scheme}.png`),
        });
      }
      await page.locator('#econ-hours').fill('3');
      assert.equal(await list.locator(':scope > li').count(), 0);
      assert.match(await status.innerText(), /på nytt/);
      await page.locator('#econ-hours').fill('4');
      delay = 200;
      await button.click();
      await page.waitForTimeout(30);
      await page.locator('#econ-hours').fill('2');
      await page.waitForTimeout(230);
      assert.equal(await list.locator(':scope > li').count(), 0);
      delay = 0;
      mode = 'failure';
      await button.click();
      await page.waitForFunction(() =>
        document.querySelector('#econ-data-status').textContent.includes('kunde inte bedömas'),
      );
      assert.doesNotMatch(await status.innerText(), /private failure/);
      assert.equal(await button.isDisabled(), false);
      mode = 'malformed';
      await button.click();
      await page.waitForFunction(() =>
        document.querySelector('#econ-data-status').textContent.includes('kunde inte bedömas'),
      );
      assert.equal(await list.locator(':scope > li').count(), 0);
      reset();
      await page.locator('#econ-hours').fill('4');
      await page.locator('#econ-solar-enabled').check();
      await button.click();
      await page.waitForFunction(
        () => document.querySelector('#econ-data-checks').children.length === 15,
      );
      assert.match(await status.innerText(), /täckta/);
      assert.equal(await page.locator('#econ-ev-absent-confirm').isChecked(), false);
      assert.equal(await page.locator('#econ-ev-history-confirm').isChecked(), false);
      f.rows[0].fieldCoverageMs.pvW = 0;
      f.rows[1].evWh = 50;
      await button.click();
      await page.waitForFunction(() =>
        document.querySelector('#econ-data-status').textContent.includes('ofullständigt'),
      );
      assert.match(await list.innerText(), /Registrerad billaddning/);
      assert.match(await list.innerText(), /1 kvart saknas/);
      const before = posts;
      await page.locator('#econ-hours').fill('169');
      await button.click();
      assert.equal(posts, before);
      assert.match(await status.innerText(), /168/);
    }
    assert.deepEqual(errors, []);
    console.log(
      'Economic readiness browser checks passed: real scanner, all simultaneous gaps, text ranges, both modes, no writes, changed selection, late/error/malformed replies, no inferred confirmations, light/dark and no overflow.',
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
