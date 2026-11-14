'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  bounds,
  monthKey,
  shiftMonth,
  validateArchive,
  readArchive,
  replaceMonth,
  mergeArchive,
} = require('../lib/pricing/consumption-archive');
const HOUR = 3600000,
  now = new Date('2026-11-13T12:00Z');
function state(month, value = 1, revision = 'r') {
  const b = bounds(month),
    to = Math.min(b.to, Math.floor(+now / HOUR) * HOUR);
  return {
    schema: 1,
    source: 'tibber-consumption',
    resolution: 'HOURLY',
    configRevision: revision,
    fetchedAt: now.toISOString(),
    from: b.from,
    to,
    hours: [{ t: b.from, importWh: value }],
  };
}
test('monthly boundaries preserve 23/25-hour DST days and 745-hour October', () => {
  assert.equal((bounds('2026-10').to - bounds('2026-10').from) / HOUR, 745);
  assert.equal((bounds('2026-03').to - bounds('2026-03').from) / HOUR, 743);
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(monthKey(new Date('2026-10-31T23:00Z')), '2026-11');
  assert.throws(() => bounds('2026-99'));
});
test('lazy migration splits legacy month windows, preserves gaps/zeros and does not write', () => {
  const a = state('2026-10', 0);
  a.from = bounds('2026-11').from - HOUR;
  a.to = a.from + 2 * HOUR;
  a.hours = [
    { t: a.from, importWh: 0 },
    { t: a.from + HOUR, importWh: 2 },
  ];
  const settings = {
    get: (k) => (k === 'tibberConsumptionHistory' ? a : null),
    set() {
      throw Error('Read only');
    },
  };
  const result = readArchive(settings, now);
  assert.deepEqual(
    result.months.map((e) => e.month),
    ['2026-10', '2026-11'],
  );
  assert.equal(result.months[0].state.hours[0].importWh, 0);
  assert.equal(readArchive({ get: () => null }, now), null);
});
test('rollover retains months, correction snapshots replace old hours and retention stays bounded', () => {
  let archive = null;
  for (let i = 13; i >= 0; i--)
    archive = replaceMonth(archive, state(shiftMonth('2026-11', -i)), now);
  assert.equal(archive.months.length, 13);
  assert.equal(archive.months[0].month, '2025-11');
  archive = replaceMonth(archive, state('2026-10', 4), now);
  assert.equal(archive.months.find((e) => e.month === '2026-10').state.hours[0].importWh, 4);
  const empty = { ...state('2026-10'), hours: [] };
  archive = replaceMonth(archive, empty, now);
  assert.equal(archive.months.find((e) => e.month === '2026-10').state.hours.length, 0);
  assert.equal(replaceMonth(archive, state('2026-11', 2, 'new'), now).months.length, 1);
  assert.equal(
    readArchive({ get: (k) => (k === 'tibberConsumptionArchive' ? archive : null) }, now).months
      .length,
    13,
  );
});
test('archive merge keeps existing overlapping hours and rebinds only through explicit caller policy', () => {
  const current = replaceMonth(null, state('2026-10', 7), now);
  const incoming = replaceMonth(null, state('2026-10', 1, 'old'), now);
  const merged = mergeArchive(current, incoming, 'r', now);
  assert.equal(merged.conflicts, 1);
  assert.equal(merged.archive.months[0].state.hours[0].importWh, 7);
  assert.equal(merged.archive.months[0].state.configRevision, 'r');
  assert.deepEqual(mergeArchive(merged.archive, incoming, 'r', now).archive, merged.archive);
  assert.throws(() => mergeArchive(current, incoming, null, now));
});
test('malformed, duplicate, oversized and cross-month archives fail validation', () => {
  const a = replaceMonth(null, state('2026-10'), now);
  for (const mutate of [
    (x) => {
      x.secret = 'token';
    },
    (x) => {
      x.months.push(x.months[0]);
    },
    (x) => {
      x.months[0].state.configRevision = 'other';
    },
    (x) => {
      x.months[0].state.to = bounds('2026-11').to;
    },
    (x) => {
      x.months[0].extra = true;
    },
    (x) => {
      x.months = Array(14).fill(x.months[0]);
    },
    (x) => {
      x.months[0].state.fetchedAt = '2027-01-01T00:00Z';
    },
  ]) {
    const copy = structuredClone(a);
    mutate(copy);
    assert.throws(() => validateArchive(copy, now));
  }
  assert.throws(() => validateArchive(null, now));
});
module.exports = { state, now };

test('thirteen full synthetic months fit the archive budget and keep hourly source resolution', () => {
  let archive = null;
  for (let i = 12; i >= 0; i--) {
    const s = state(shiftMonth('2026-11', -i));
    s.hours = Array.from({ length: (s.to - s.from) / HOUR }, (_, j) => ({
      t: s.from + j * HOUR,
      importWh: 12345.6789,
    }));
    archive = replaceMonth(archive, s, now);
  }
  assert.equal(archive.months.length, 13);
  assert.ok(Buffer.byteLength(JSON.stringify(archive)) < 1024 * 1024);
  assert.equal(validateArchive(archive, now), archive);
  const tooLarge = structuredClone(archive);
  tooLarge.configRevision = 'x'.repeat(1024 * 1024);
  for (const entry of tooLarge.months) entry.state.configRevision = tooLarge.configRevision;
  assert.throws(() => validateArchive(tooLarge, now), /too large/);
});
