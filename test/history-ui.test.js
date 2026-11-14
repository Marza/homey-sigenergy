'use strict';
const { attachWidgetApi } = require('./widget-helper');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function render(file, row, start, canonical = false) {
  const elements = new Map();
  const document = {
    querySelectorAll: () => [],
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { textContent: '–', innerHTML: '' });
      return elements.get(id);
    },
  };
  const Homey = {
    get(key, callback) {
      if (canonical && key === 'historyState')
        callback(null, { schema: 3, slots: [row], daily: [], events: [], legacyDaily: [] });
      else
        callback(
          null,
          key === 'historySlots'
            ? [row]
            : key === 'sourceConfig'
              ? { sigenergy: { configured: true, enabled: true } }
              : key === 'sigenergyStatus'
                ? { readAt: new Date().toISOString() }
                : undefined,
        );
    },
    ready() {},
  };
  if (file.startsWith('widgets/')) attachWidgetApi(Homey);
  const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const script =
    fs.readFileSync(path.join(__dirname, '../lib/widget-layout.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(__dirname, '../lib/tariff-config.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(__dirname, '../lib/pricing/coverage.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(__dirname, '../lib/source-status.js'), 'utf8') +
    '\n' +
    [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  vm.runInNewContext(script + '\n' + start, {
    document,
    Homey,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval() {},
  });
  return (id) => String(elements.get(id).textContent).replace(/[\u00a0\u202f]/g, ' ');
}

for (const [file, start, ids] of [
  ['settings/index.html', 'loadOverview(Homey)', ['gridPower', 'pvPower', 'batterySoc']],
  ['widgets/energy-overview/public/index.html', 'onHomeyReady(Homey)', ['grid', 'pv', 'soc']],
]) {
  test(`${file}: EVDC samples do not dilute plant averages`, () => {
    const text = render(
      file,
      {
        schema: 2,
        t: Date.now(),
        n: 4,
        counts: { gridW: 2, pvW: 2, soc: 2, evW: 2 },
        sum: { gridW: 6000, pvW: 2000, soc: 120, evW: 8000 },
      },
      start,
    );
    assert.equal(text(ids[0]), '3 kW');
    assert.equal(text(ids[1]), '1 kW');
    assert.equal(text(ids[2]), '60 %');
  });
  test(`${file}: legacy and missing counts show unknown rather than invented averages`, () => {
    for (const counts of [undefined, {}]) {
      const text = render(
        file,
        { t: Date.now(), n: 2, counts, sum: { gridW: 6000, pvW: 2000, soc: 120 } },
        start,
      );
      assert.deepEqual(ids.map(text), ['–', '–', '–']);
    }
  });
  test(`${file}: observed zeros remain distinguishable from missing fields`, () => {
    const text = render(
      file,
      { schema: 2, t: Date.now(), n: 1, counts: { gridW: 1 }, sum: { gridW: 0 } },
      start,
    );
    assert.deepEqual(ids.map(text), ['0 kW', '–', '–']);
  });
  test(`${file}: canonical history takes precedence over the frozen legacy keys`, () => {
    const text = render(
      file,
      { schema: 2, t: Date.now(), n: 1, counts: { gridW: 1 }, sum: { gridW: 2000 } },
      start,
      true,
    );
    assert.equal(text(ids[0]), '2 kW');
  });
}

// Battery sign follows the existing plant convention: positive charges.
for (const [watts, expected] of [
  [2400, 'Laddar 2,4 kW'],
  [-1600, 'Urladdar 1,6 kW'],
  [0, 'Vila 0 kW'],
]) {
  test(`widget shows battery direction for ${watts} W without EV sample dilution`, () => {
    const text = render(
      'widgets/energy-overview/public/index.html',
      {
        t: Date.now(),
        n: 5,
        counts: { essW: 2, soc: 1, evW: 3 },
        sum: { essW: watts * 2, soc: 65, evW: 9000 },
      },
      'onHomeyReady(Homey)',
      true,
    );
    assert.equal(text('batteryPower'), expected);
    assert.equal(text('soc'), '65 %');
  });
}
test('widget leaves missing, legacy or non-finite battery power unknown', () => {
  for (const row of [
    { sum: { essW: 1200 } },
    { counts: { essW: 0 }, sum: { essW: 0 } },
    { counts: { essW: 1 }, sum: { essW: NaN } },
    { counts: { soc: 1 }, sum: { soc: 65 } },
  ]) {
    const text = render(
      'widgets/energy-overview/public/index.html',
      { t: Date.now(), ...row },
      'onHomeyReady(Homey)',
      true,
    );
    assert.equal(text('batteryPower'), '–');
  }
});
