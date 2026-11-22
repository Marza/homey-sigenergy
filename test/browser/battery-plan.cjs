'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { calendar } = require('../../lib/pricing/coverage');
const { optimize, Q } = require('../../lib/energy/battery-plan');
const now = Date.parse('2026-11-22T09:07:00Z');
const days = calendar(new Date(now));
const quarters = Array.from({ length: 96 * 2 }, (_, i) => {
  const h = (i % 96) / 4;
  const buy =
    i >= 96
      ? null
      : 1.62 -
        0.62 * Math.exp(-((h - 5) ** 2) / 4) -
        0.94 * Math.exp(-((h - 12) ** 2) / 9) +
        0.97 * Math.exp(-((h - 18) ** 2) / 12) +
        0.05 * Math.sin(i * 0.73);
  return {
    t: days.today.start + i * Q,
    buy,
    sell: buy === null ? null : (buy - 0.09) / 1.25 - 0.43,
  };
});
const measured = Array.from({ length: 121 }, (_, i) => ({
  t: days.today.start + i * 300000,
  soc: 38 + 25 * Math.exp(-((i - 77) ** 2) / 730) - i / 7,
}));
const liveSoc = measured.at(-1).soc;
const plan = optimize(
  quarters
    .filter((q) => q.t > now && q.buy !== null)
    .map((q) => ({ ...q, wear: 0.05, netKWh: 0.48 })),
  {
    soc: liveSoc,
    low: 15,
    high: 95,
    capacity: 20,
    chargeKW: 5,
    dischargeKW: 5,
    importKW: 12,
  },
);
const sample = { days, now, quarters, measured, liveSoc, plan, reason: 'prices' };
async function run() {
  const browser = await chromium.launch();
  try {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({
        colorScheme: theme,
        viewport: { width: 400, height: 700 },
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const dir = path.resolve(__dirname, '../../widgets/battery-plan');
      await page.goto(pathToFileURL(path.join(dir, 'public/index.html')).href);
      await page.evaluate(
        (data) => window.onHomeyReady({ api: async () => data, ready() {}, setHeight() {} }),
        sample,
      );
      await page.locator('.window').first().waitFor();
      assert.ok((await page.locator('#chart path').count()) === 4);
      assert.match(await page.locator('#status').innerText(), /priser/);
      if (process.argv.includes('--previews'))
        await page
          .locator('main')
          .screenshot({ path: path.join(dir, 'preview-' + theme + '.png') });
      await page.locator('#cursor').fill('60');
      assert.match(await page.locator('#detail').innerText(), /Prognos/);
      await page.locator('#day').selectOption('tomorrow');
      assert.equal(await page.locator('#chart path').count(), 0);
      await page.setViewportSize({ width: 320, height: 650 });
      await page.locator('summary').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
