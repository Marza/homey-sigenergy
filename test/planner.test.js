'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, upcomingDeadlines, planCharging } = require('../lib/charging/planner');
const config = () => JSON.parse(JSON.stringify(DEFAULTS));
const now = new Date('2026-11-12T20:00:00Z');
function slots() {
  return Array.from({ length: 48 }, (_, i) => {
    const start = new Date(now.getTime() + i * 900000);
    return {
      start: start.toISOString(),
      end: new Date(start.getTime() + 900000).toISOString(),
      price: i === 12 ? 0.1 : 1,
    };
  });
}
test('default minimum is 30% at 07:00 Stockholm', () => {
  const d = upcomingDeadlines(config(), now, 12);
  assert.equal(d.length, 1);
  assert.equal(d[0].at.toISOString(), '2026-11-13T06:00:00.000Z');
  assert.equal(d[0].soc, 30);
});
test('already above minimum requires no charge', () => {
  const plan = planCharging({ now, currentSoc: 45, config: config(), prices: slots() });
  assert.equal(plan.slots.length, 0);
  assert.equal(plan.status, 'planned');
});
test('selects cheaper available slots before deadline', () => {
  const plan = planCharging({ now, currentSoc: 29, config: config(), prices: slots() });
  assert.equal(plan.slots.length, 1);
  assert.equal(plan.slots[0].start, slots()[12].start);
});
test('daily target adds an additional deadline', () => {
  const c = config();
  c.dailyTargets.fri = { enabled: true, time: '07:30', soc: 80 };
  const d = upcomingDeadlines(c, now, 12);
  assert.equal(d.length, 2);
  assert.equal(d[1].soc, 80);
});
test('unreachable target is reported, not silently promised', () => {
  const c = config();
  c.maxChargingPowerKW = 1;
  const p = planCharging({ now, currentSoc: 0, config: c, prices: slots() });
  assert.equal(p.status, 'unreachable');
  assert.ok(p.unmet.length);
});
test('rejects overlapping price slots', () => {
  const p = slots();
  p[1].start = p[0].start;
  assert.throws(
    () => planCharging({ now, currentSoc: 20, config: config(), prices: p }),
    /Overlapping/,
  );
});
