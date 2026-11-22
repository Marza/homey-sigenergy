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
async function checkTradeThreshold(page) {
  const trades = [
    ['sell', 0.00241],
    ['house', 0],
    ['sell', 0.9999],
    ['buy', 0.1],
    ['sell', 0.4],
    ['sell', 0.6],
    ['hold', 0],
    ['sell', 1.25],
  ];
  const data = {
    ...sample,
    plan: trades.map(([action, kWh], i) => ({
      t: quarters[i].t,
      action,
      soc: 70,
      endSoc: 69,
      buyKWh: action === 'buy' ? kWh : 0,
      sellKWh: action === 'sell' ? kWh : 0,
    })),
  };
  const render = (index, report = data) =>
    page.evaluate(({ report, index }) => window.draw(report, 'today', index), { report, index });
  await render(0);
  assert.deepEqual(await page.locator('.window span').allTextContents(), [
    'Nätladda · 0,1 kWh',
    'Sälj från batteriet · 1 kWh',
    'Sälj från batteriet · 1,25 kWh',
  ]);
  assert.match(await page.locator('#detail').innerText(), /Använd i huset/);
  await render(2);
  assert.match(await page.locator('#detail').innerText(), /Använd i huset/);
  await render(5);
  assert.match(await page.locator('#detail').innerText(), /Sälj från batteriet/);
  await render(0, { ...data, plan: data.plan.slice(0, 3) });
  assert.match(await page.locator('#actions').innerText(), /Inga föreslagna batteriaffärer/);
}
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
      await checkTradeThreshold(page);
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
