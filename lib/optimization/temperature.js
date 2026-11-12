'use strict';
// No invented temperature-to-power curve: only actual BMS limits may constrain dispatch.
function temperatureContext({ outdoorC, batteryC, chargeLimitKW, dischargeLimitKW, now = Date.now(), observedAt } = {}) {
  const fresh = Number.isFinite(Date.parse(observedAt || '')) && now >= Date.parse(observedAt) && now - Date.parse(observedAt) <= 10 * 60000;
  const valid = v => Number.isFinite(v) && v >= -50 && v <= 100;
  return {
    outdoorC: valid(outdoorC) ? outdoorC : null,
    batteryC: fresh && valid(batteryC) ? batteryC : null,
    chargeLimitKW: fresh && Number.isFinite(chargeLimitKW) && chargeLimitKW > 0 ? chargeLimitKW : null,
    dischargeLimitKW: fresh && Number.isFinite(dischargeLimitKW) && dischargeLimitKW > 0 ? dischargeLimitKW : null,
    confidence: fresh && Number.isFinite(dischargeLimitKW) && dischargeLimitKW > 0 ? 'measured-bms-limit' : 'unknown',
    advisoryOnly: true,
  };
}
module.exports = { temperatureContext };
