'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(process.env.SETTINGS_UI_ROOT || path.join(__dirname, '../..'));
const { DEFAULTS } = require(path.join(root, 'lib/charging/planner'));
const hostCss = fs.readFileSync(
  process.env.SETTINGS_HOST_CSS || path.join(__dirname, '../fixtures/settings-host-reset.css'),
);
const categories = [
  'connections',
  'costs',
  'tariff',
  'car',
  'battery',
  'solar',
  'economics',
  'data',
];
function contrast(a, b) {
  function luminance(color) {
    const rgb = color
      .match(/[\d.]+/g)
      .slice(0, 3)
      .map((x) => Number(x) / 255);
    return rgb
      .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
      .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
  }
  const light = luminance(a),
    dark = luminance(b);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}
const server = http.createServer((req, res) => {
  if (req.url === '/homey.js') {
    res.setHeader('Content-Type', 'text/javascript');
    // The host CSS arrives after the app CSS, before onHomeyReady, like the SDK.
    res.end(`window.Homey={
      get:(key,cb)=>cb(null,key==='chargingConfig'?${JSON.stringify(DEFAULTS)}:null),
      set:()=>{throw Error('This styling test must not save settings');},
      api:(method,url,body,cb)=>cb(Error('Synthetic unavailable data')),
      ready:()=>window.appReady=true
    };document.addEventListener('DOMContentLoaded',()=>{
      const link=document.createElement('link');link.rel='stylesheet';link.href='/host.css';
      link.onload=()=>onHomeyReady(Homey);document.head.appendChild(link);
    });`);
    return;
  }
  if (req.url === '/host.css') {
    res.setHeader('Content-Type', 'text/css');
    res.end(hostCss);
    return;
  }
  const name = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!/^[\w.-]+$/.test(name)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const file = fs.readFileSync(path.join(root, 'settings', name));
    res.setHeader(
      'Content-Type',
      name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
    );
    res.end(file);
  } catch {
    res.writeHead(404).end();
  }
});
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      ...(process.env.SETTINGS_CHROMIUM ? { executablePath: process.env.SETTINGS_CHROMIUM } : {}),
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const [width, scheme] of [
      [320, 'light'],
      [390, 'dark'],
      [1100, 'light'],
      [1100, 'dark'],
    ]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.waitForFunction(() => window.appReady);
      assert.equal(await page.locator('link').last().getAttribute('href'), '/host.css');
      await page.locator('#tab-settings').click();
      for (const category of categories) {
        if (width < 768) await page.locator('#settingsCategory').selectOption(category);
        else await page.locator(`[data-settings-category="${category}"]`).click();
        await page.locator('.settings-page:visible details').evaluateAll((details) => {
          for (const detail of details) detail.open = true;
        });
        const fields = await page
          .locator(
            '.settings-page:visible input:not([type="checkbox"]), .settings-page:visible select, #settingsCategory:visible',
          )
          .evaluateAll((elements) =>
            elements.map((element) => {
              const css = getComputedStyle(element);
              return {
                id: element.id,
                sides: ['Top', 'Right', 'Bottom', 'Left'].map((side) => [
                  css['border' + side + 'Width'],
                  css['border' + side + 'Style'],
                ]),
                color: css.color,
                background: css.backgroundColor,
                border: css.borderTopColor,
                radius: parseFloat(css.borderRadius),
                font: parseFloat(css.fontSize),
                paddingX: parseFloat(css.paddingLeft),
                paddingY: parseFloat(css.paddingTop),
                height: element.getBoundingClientRect().height,
                disabled: element.matches(':disabled'),
              };
            }),
          );
        assert.ok(fields.length, category + ' has controls');
        for (const field of fields.sort(
          (a, b) => Number(a.id === 'settingsCategory') - Number(b.id === 'settingsCategory'),
        )) {
          const context = `${width}/${scheme}/${category}/${field.id}`;
          assert.deepEqual(field.sides, Array(4).fill(['2px', 'solid']), context);
          assert.ok(field.radius >= 10 && field.paddingX >= 12 && field.paddingY >= 10, context);
          assert.ok(field.font >= 16 && field.height >= 44, context);
          assert.notEqual(field.background, 'rgba(0, 0, 0, 0)', context);
          if (!field.disabled) assert.ok(contrast(field.border, field.background) >= 3, context);
          assert.ok(contrast(field.color, field.background) >= 4.5, context);
        }
        const label = page.locator('.settings-page:visible label').first();
        if (await label.count())
          assert.equal(await label.evaluate((e) => getComputedStyle(e).textTransform), 'none');
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          category + ' must fit',
        );
      }
      if (width < 768) await page.locator('#settingsCategory').selectOption('costs');
      else await page.locator('[data-settings-category="costs"]').click();
      await page.locator('#costEnergyTax').focus();
      assert.deepEqual(
        await page.locator('#costEnergyTax').evaluate((e) => {
          const c = getComputedStyle(e);
          return [c.outlineWidth, c.outlineStyle, c.outlineOffset];
        }),
        ['3px', 'solid', '3px'],
      );
      const card = await page
        .locator('#costContractPanel')
        .evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft));
      assert.ok(card >= 16, 'Host universal reset must not remove card padding');
      assert.equal(
        await page.locator('#saveCostContract').evaluate((e) => getComputedStyle(e).borderRadius),
        '12px',
      );
      // The host reset must not remove spacing or touch targets from primary actions.
      assert.ok(
        await page
          .locator('#saveCostContract')
          .evaluate((e) => e.getBoundingClientRect().height >= 44),
      );
      if (process.env.SETTINGS_SCREENSHOTS) {
        fs.mkdirSync(process.env.SETTINGS_SCREENSHOTS, { recursive: true });
        await page.locator('#costEnergyTax').blur();
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({
          fullPage: true,
          path: path.join(process.env.SETTINGS_SCREENSHOTS, `costs-${width}-${scheme}.png`),
        });
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      'Settings styling passed: late host CSS, all categories, light/dark, phone/desktop, borders, contrast, spacing and focus.',
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
