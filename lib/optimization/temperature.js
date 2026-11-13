'use strict';
const { isFresh, MAX_AGE_MS } = require('../source-status');
// No invented temperature-to-power curve: only actual BMS limits may constrain dispatch.
function temperatureContext({
  outdoorC,
  batteryC,
  chargeLimitKW,
  dischargeLimitKW,
  now = Date.now(),
  observedAt,
  outdoorObservedAt,
} = {}) {
  const fresh = isFresh(observedAt, MAX_AGE_MS.battery, now);
  const valid = (v) => Number.isFinite(v) && v >= -50 && v <= 100;
  return {
    outdoorC: isFresh(outdoorObservedAt, MAX_AGE_MS.nibe, now) && valid(outdoorC) ? outdoorC : null,
    batteryC: fresh && valid(batteryC) ? batteryC : null,
    chargeLimitKW:
      fresh && Number.isFinite(chargeLimitKW) && chargeLimitKW > 0 ? chargeLimitKW : null,
    dischargeLimitKW:
      fresh && Number.isFinite(dischargeLimitKW) && dischargeLimitKW > 0 ? dischargeLimitKW : null,
    confidence:
      fresh && Number.isFinite(dischargeLimitKW) && dischargeLimitKW > 0
        ? 'measured-bms-limit'
        : 'unknown',
    advisoryOnly: true,
  };
}
module.exports = { temperatureContext };
