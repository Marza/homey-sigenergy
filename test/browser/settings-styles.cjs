'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(process.env.SETTINGS_UI_ROOT || path.join(__dirname, '../..'));
const hostCss = fs.readFileSync(
  process.env.SETTINGS_HOST_CSS || path.join(__dirname, '../fixtures/settings-host-reset.css'),
);
const categories = ['connections', 'household', 'costs', 'tariff', 'economics', 'data'];
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
    const initial = {
      householdImportLimits: { importLimitKW: 17.3, mainFuseA: 25 },
      costContract: {
        schema: 2,
        currency: 'SEK',
        source: 'Synthetic contract',
        checkedOn: '2026-06-01',
        importPriceBasis: 'spot-ex-vat',
        importIncludesEnergyTax: false,
        energyTaxExVatSekPerKWh: 0.3,
        gridImportExVatSekPerKWh: 0.1,
        otherImportExVatSekPerKWh: 0.05,
        gridExportBenefitSekPerKWh: 0.04,
        gridExportFeeSekPerKWh: 0,
        vatRate: 0.25,
        batteryWearSekPerKWh: 0,
      },
      demandTariff: {
        start: '07:00',
        end: '20:00',
        weekdays: [0, 2, 5],
        months: [11, 12, 1, 2, 3],
        peakCount: 3,
        distinctDays: true,
        rateSekPerKw: 40,
      },
    };
    const { HouseholdForecast } = require('../../lib/energy/household-forecast');
    const map = new Map(),
      q = 900000,
      start = Date.parse('2026-10-18T12:00Z');
    const rows = Array.from({ length: 96 * 18 }, (_, i) => ({
      t: start + i * q,
      householdCoverageMs: q,
      householdWh: 250,
    }));
    const model = new HouseholdForecast(
      { get: (k) => map.get(k), set: (k, v) => map.set(k, v) },
      { getSlots: () => rows },
    );
    model.refresh(start + q * 96 * 14);
    // The earlier issued forecast lacked a quarter that later received a complete measurement.
    map.get('householdForecastV1').issues.at(-1).wh[12] = null;
    const forecast = model.report(start + q * 96 * 15 + q);
    const solarStart = Date.parse('2026-11-27T15:15Z');
    const solarAt = solarStart - q,
      solar = {
        at: solarAt,
        start: solarStart,
        roofs: [
          {
            name: 'Söder',
            kwp: 4,
            tilt: 30,
            bearing: 180,
            wh: Array.from({ length: 96 }, (_, i) =>
              i < 65 || i >= 90 ? 0 : i === 66 ? null : 100,
            ),
          },
        ],
        loss: 14,
        actualWh: [0, 120, null, ...Array(93).fill(null)],
      };
    res.end(`window.syntheticSettings=${JSON.stringify(initial)};window.syntheticWrites=[];window.syntheticApiWrites=[];window.Homey={
      get:(key,cb)=>setTimeout(()=>new URLSearchParams(location.search).has('readFail')&&['demandTariff','chargingConfig'].includes(key)?cb(Error('Synthetic read failure')):cb(null,structuredClone(window.syntheticSettings[key]??null)),20),
      set:(key,value,cb)=>{window.syntheticWrites.push(key);window.syntheticSettings[key]=structuredClone(value);setTimeout(()=>cb(null),20);},
      api:(method,url,body,cb)=>{if(method!=='GET')window.syntheticApiWrites.push(url);if(url==='/forecast/solar/config'){window.solarConfig=structuredClone(body);cb(null,body);}
        else if(url.startsWith('/forecast/solar'))cb(null,{config:window.solarConfig,status:window.solarConfig?.enabled?'ok':'off',issued:window.solarConfig?.enabled?[${solarAt}]:[],issue:window.solarConfig?.enabled?(window.solarTestIssue ?? ${JSON.stringify(solar)}):null});
        else if(url==='/forecast/household')cb(null,${JSON.stringify(forecast)});else cb(Error('Synthetic unavailable data'));},
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
  const requestPath = new URL(req.url, 'http://localhost').pathname;
  const name = requestPath === '/' ? 'index.html' : requestPath.slice(1);
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
      await page.locator('#tab-forecast').click();
      await page.waitForSelector('#forecast-chart svg');
      assert.equal(await page.locator('#forecast-total').innerText(), '24 kWh');
      assert.equal(await page.locator('#forecast-chart table tr').count(), 97);
      assert.equal(await page.locator('#forecast-comparison svg path').count(), 2);
      const accuracy = await page.locator('#forecast-accuracy').innerText();
      assert.match(accuracy, /24-timmarsprognoser: 1.*Helt utvärderade: 0/);
      assert.match(accuracy, /95 av 96.*utan prognos: 1.*utan komplett mätning: 0/);
      await page.locator('#tab-settings').click();
      for (const category of categories) {
        if (width < 768) await page.locator('#settingsCategory').selectOption(category);
        else await page.locator(`[data-settings-category="${category}"]`).click();
        await page.locator('.settings-page:visible details').evaluateAll((details) => {
          for (const detail of details) detail.open = true;
        });
        if (category === 'economics') {
          await page.locator('#costVersionBackup').evaluate((detail) => (detail.open = false));
          assert.equal(await page.locator('#econ-refresh').isVisible(), true);
          await page.locator('#econ-refresh').click();
          assert.equal(await page.locator('#econ-refresh-message').isVisible(), true);
          assert.match(
            await page.locator('#econ-refresh-message').textContent(),
            /Omläsningen misslyckades: Synthetic unavailable data/,
          );
          assert.equal(await page.locator('#econ-export').isVisible(), false);
          await page.locator('#costVersionBackup').evaluate((detail) => (detail.open = true));
        }
        const fields = await page
          .locator(
            '.settings-page:visible input:not([type="checkbox"]):not([type="hidden"]), .settings-page:visible select, #settingsCategory:visible',
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
      async function category(name) {
        if (width < 768) await page.locator('#settingsCategory').selectOption(name);
        else await page.locator(`[data-settings-category="${name}"]`).click();
      }
      assert.deepEqual(await page.evaluate(() => window.syntheticWrites), []);
      assert.deepEqual(await page.evaluate(() => window.syntheticApiWrites), []);
      await category('connections');
      assert.equal(await page.locator('#nibeIslandEnabled').isChecked(), false);
      await page.locator('#nibeHost').fill('pump.test');
      await page.locator('#nibeIslandEnabled').check();
      await page.locator('#saveNibe').click();
      await page.waitForFunction(
        () =>
          window.syntheticSettings.nibeIslandEndpoint === JSON.stringify(['pump.test', 502, 1, 0]),
      );
      await page.locator('#nibeHost').fill('replacement.test');
      assert.equal(await page.locator('#nibeIslandEnabled').isChecked(), false);
      await page.locator('#saveNibe').click();
      await page.waitForFunction(() => window.syntheticSettings.nibeIslandEndpoint === null);
      await page.locator('#setupGuide > summary').click();
      assert.equal(await page.locator('#setupGuide [data-settings-link]').count(), 5);
      await page.locator('#setupGuide [data-settings-link="tariff"]').click();
      assert.equal(await page.locator('#setupGuide').evaluate((e) => e.open), false);
      assert.equal(await page.locator('#settings-tariff').isVisible(), true);
      await category('tariff');
      for (const day of [0, 2, 5])
        assert.equal(await page.locator('#tariffDay' + day).isChecked(), true);
      assert.equal(await page.locator('#tariffDay1').isChecked(), false);
      assert.match(await page.locator('#tariffConfigStatus').innerText(), /söndag, tisdag, fredag/);
      await page.locator('[data-weekday-preset="weekdays"]').click();
      assert.equal(await page.locator('#tariffWeekdays').inputValue(), '1,2,3,4,5');
      assert.deepEqual(
        await page.evaluate(() => window.syntheticSettings.demandTariff.weekdays),
        [0, 2, 5],
      );
      await page.locator('#saveTariff').click();
      await page.waitForFunction(() =>
        document.querySelector('#tariffMessage').textContent.includes('sparade'),
      );
      assert.deepEqual(
        await page.evaluate(() => window.syntheticSettings.demandTariff.weekdays),
        [1, 2, 3, 4, 5],
      );
      for (const day of [1, 2, 3, 4, 5]) await page.locator('#tariffDay' + day).uncheck();
      const count = await page.evaluate(() => window.syntheticWrites.length);
      await page.locator('#saveTariff').click();
      assert.match(await page.locator('#tariffMessage').innerText(), /Välj minst en veckodag/);
      assert.equal(await page.evaluate(() => window.syntheticWrites.length), count);
      await page.locator('[data-weekday-preset="all"]').click();
      assert.equal(await page.locator('#tariffWeekdays').inputValue(), '1,2,3,4,5,6,0');
      await category('costs');
      await page.locator('#costOtherImport').fill('0,037125');
      assert.match(await page.locator('#unit-preview-costOtherImport').innerText(), /3,7125 öre/);
      assert.equal(await page.locator('#costOtherImport').inputValue(), '0,037125');
      await page.locator('#costVatRate').fill('0,2');
      assert.match(await page.locator('#unit-preview-costVatRate').innerText(), /20 %/);
      await page.locator('#costSetToday').click();
      assert.equal(
        await page.locator('#costCheckedOn').inputValue(),
        await page.evaluate(() => {
          const n = new Date();
          return [
            n.getFullYear(),
            String(n.getMonth() + 1).padStart(2, '0'),
            String(n.getDate()).padStart(2, '0'),
          ].join('-');
        }),
      );
      assert.equal(await page.locator('#econ-from').inputValue(), '');
      await category('household');
      assert.equal(await page.locator('#household-tariff-target').inputValue(), '3');
      await page.locator('#household-tariff-target').fill('0');
      await page.locator('#household-save-limits').click();
      assert.match(await page.locator('#household-limits-status').innerText(), /effektmål/);
      await page.locator('#household-tariff-target').fill('2,5');
      await page.locator('#household-save-limits').click();
      assert.deepEqual(await page.evaluate(() => window.syntheticSettings.householdImportLimits), {
        importLimitKW: 17.3,
        mainFuseA: 25,
        tariffTargetKW: 2.5,
      });
      await category('costs');
      assert.equal(await page.locator('#costOtherImport').inputValue(), '0,037125');
      await page.locator('#saveCostContract').click();
      await page.waitForFunction(() =>
        document.querySelector('#costMessage').textContent.includes('sparat och återläst'),
      );
      assert.equal(
        await page.evaluate(() => window.syntheticSettings.costContract.otherImportExVatSekPerKWh),
        0.037125,
      );
      assert.equal(await page.evaluate(() => window.syntheticSettings.costContract.vatRate), 0.2);
      assert.equal(await page.locator('#econ-date-confirm').isChecked(), false);
      await category('data');
      await page.locator('[data-settings-detail]').click();
      assert.equal(await page.locator('#settings-economics').isVisible(), true);
      assert.equal(await page.locator('#econ-export').isVisible(), true);
      assert.deepEqual(await page.evaluate(() => window.syntheticApiWrites), []);
      await category('costs');
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
    await page.goto(`http://127.0.0.1:${server.address().port}/?readFail=1`);
    await page.waitForFunction(() =>
      document.querySelector('#tariffMessage').textContent.includes('kunde inte läsas'),
    );
    for (const day of [0, 1, 2, 3, 4, 5, 6])
      assert.equal(await page.locator('#tariffDay' + day).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.syntheticWrites), []);
    assert.deepEqual(await page.evaluate(() => window.syntheticApiWrites), []);
    await page.locator('#tab-forecast').click();
    await page.locator('#solar-setup summary').click();
    await page.locator('#solar-enabled').check();
    await page.locator('#solar-lat').fill('59');
    await page.locator('#solar-lon').fill('18');
    const roof = page.locator('#solar-roofs fieldset').first();
    await roof.getByLabel('Namn').fill('Söder');
    await roof.getByLabel('Paneleffekt (kWp)').fill('4');
    await roof.getByLabel('Lutning från horisontalplanet (°)').fill('30');
    await roof.getByLabel('Kompassriktning (°)').fill('180');
    await page.locator('#solar-add').click();
    await page.locator('#solar-roofs fieldset').last().getByRole('button').click();
    await page.locator('#solar-save').click();
    await page.locator('#solar-chart svg').waitFor();
    assert.match(
      await page.locator('#solar-totals').innerText(),
      /Söder · Ofullständig prognos \(95\/96 kvartar\)/,
    );
    assert.match(
      await page.locator('#solar-comparison').innerText(),
      /2 jämförbara kvartar.*0 kWh.*0,12 kWh/,
    );
    const solarRows = page.locator('#solar-chart table tr');
    assert.equal(await solarRows.count(), 28);
    const firstInterval = solarRows.nth(1);
    assert.match(await firstInterval.locator('td').first().textContent(), /27.*16:15.*28.*08:30/);
    assert.equal(await firstInterval.locator('td').nth(1).textContent(), '0');
    assert.match(await firstInterval.locator('summary').textContent(), /0–0,48 \(2\/65 kvartar\)/);
    assert.match(await firstInterval.locator('li').nth(1).textContent(), /0,48 kW/);
    assert.match(await firstInterval.locator('li').nth(2).textContent(), /– kW/);
    assert.equal(await solarRows.nth(3).locator('td').nth(1).textContent(), '–');
    assert.match(await solarRows.last().locator('td').first().textContent(), /14:45.*16:15/);
    // Reopen an issued revision: score only intervals subsequent to its issuance.
    await page.evaluate(() => {
      const start = Date.parse('2026-11-27T09:00Z'),
        q = 900000;
      window.solarTestIssue = {
        at: start - q,
        start,
        roofs: [{ name: 'Söder', wh: Array(96).fill(100) }],
        actualWh: [800, 800, 800, 800, 40, null, 0, ...Array(89).fill(null)],
        adjustments: [
          {
            at: start + 3 * q + 60000,
            start: start + 4 * q,
            samples: 3,
            factor: 0.5,
            wh: [50, 50, 50],
          },
          { at: start + 4 * q + 60000, wh: null },
        ],
      };
    });
    await page.locator('#tab-forecast').click();
    assert.match(
      await page.locator('#solar-adjustment').innerText(),
      /Åter till originalprognosen/,
    );
    await page.locator('#solar-revision').selectOption({ index: 2 });
    assert.match(
      await page.locator('#solar-score').innerText(),
      /2 gemensamma kvartar: original 0,2 kWh, justerat 0,1 kWh, Sigenergy 0,04 kWh/,
    );
    assert.equal(await page.locator('#solar-chart svg path').count(), 3);
    await page.locator('#solar-chart details > summary').first().click();
    assert.match(
      await page.locator('#solar-chart tr').first().innerText(),
      /Originalprognos.*Justerad prognos.*Sigenergy/s,
    );
    assert.deepEqual(await page.evaluate(() => window.solarConfig.roofs), [
      { name: 'Söder', kwp: 4, tilt: 30, bearing: 180 },
    ]);
    assert.deepEqual(errors, []);
    console.log(
      'Settings styling and setup interactions passed: late host CSS, all categories, light/dark, phone/desktop, borders, contrast, spacing and focus.',
    );
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
