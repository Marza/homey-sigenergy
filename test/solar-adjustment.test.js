'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { adjust } = require('../lib/energy/solar-adjustment');
const Q = 900000,
  end = Date.parse('2026-03-29T12:00Z'),
  start = end - 5 * Q;
const source = { key: 'pv', since: start - 24 * Q };
const issue = {
  at: start - Q,
  start,
  key: 'config',
  source: 'pv',
  roofs: [{ kwp: 4, wh: Array(96).fill(250) }],
};
const rows = [1, 2, 3, 4].map((i) => ({
  t: start + i * Q,
  pvWh: 500,
  fieldCoverageMs: { pvW: Q },
}));
test('upside is bounded, only completed evidence is used, Stockholm DST midnight ends the revision', () => {
  const r = adjust([issue], source, end + 12345, () => [
    ...rows,
    { t: end, pvWh: 0, fieldCoverageMs: { pvW: Q } },
  ]);
  assert.equal(r.factor, 1.25);
  assert.equal(r.wh[0], 313);
  assert.equal(r.start, end + Q);
  assert.equal(r.start + r.wh.length * Q, Date.parse('2026-03-29T22:00Z'));
});
test('low light, short histories, wrong sources and stale or incomplete observations do not calibrate', () => {
  const apply = (issues, readings, src = source) =>
    adjust(issues, src, end + 12345, () => readings);
  assert.equal(apply([issue], rows, { ...source, key: 'other' }), null);
  assert.equal(apply([issue], rows, { ...source, since: end - Q }), null);
  assert.equal(apply([issue], rows.slice(0, 3)), null);
  assert.equal(apply([issue], rows.slice(-2)), null);
  assert.equal(apply([{ ...issue, roofs: [{ kwp: 4, wh: Array(96).fill(1) }] }], rows), null);
  assert.equal(apply([{ ...issue, at: end, start: end + Q }], rows), null);
  assert.equal(apply([issue, { ...issue, key: 'new', at: end, start: end + Q }], rows), null);
  assert.equal(
    apply(
      [issue],
      [
        ...rows.slice(0, 3),
        { ...rows[3], fieldCoverageMs: { pvW: Q - 1 }, energyFieldCoverageMs: { pvW: Q } },
      ],
    ),
    null,
  );
});
