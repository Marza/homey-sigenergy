'use strict';
const { scanComparisonData } = require('./comparison-data');
const { validateConfig } = require('../charging/planner');
function checkReadiness(homey, input, now = Date.now()) {
  const base = {
    advisoryOnly: true,
    controlApplied: false,
    financiallyComparable: false,
    rankingBasis: 'none',
    dataComplete: false,
  };
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !['hours', 'mode'].includes(key)) ||
    !['battery', 'solar-ev'].includes(input.mode) ||
    !Number.isInteger(input.hours) ||
    input.hours < 1 ||
    input.hours > (input.mode === 'solar-ev' ? 168 : 768) ||
    !Number.isSafeInteger(now) ||
    now < input.hours * 3600000
  )
    return { ...base, status: 'unavailable', reason: 'invalid-readiness-input' };
  let report;
  try {
    ({ report } = scanComparisonData(homey, input.hours, now, input.mode === 'solar-ev'));
  } catch {
    return { ...base, status: 'unavailable', reason: 'readiness-unavailable' };
  }
  if (input.mode === 'solar-ev') {
    let onePlant = false,
      charging = false;
    try {
      const plants = homey.drivers?.getDriver('sigenergy').getDevices();
      onePlant = Array.isArray(plants) && plants.length === 1;
    } catch {
      /* Unknown source is not accepted. */
    }
    try {
      validateConfig(homey.settings.get('chargingConfig'));
      charging = true;
    } catch {
      /* Saved EV assumptions need review. */
    }
    report.gates.push(
      {
        key: 'solarPlant',
        state: onePlant ? 'complete' : 'unavailable',
        reason: onePlant ? null : 'ambiguous-solar-plant',
      },
      {
        key: 'chargingConfig',
        state: charging ? 'complete' : 'unavailable',
        reason: charging ? null : 'charging-settings-required',
      },
    );
    if (!onePlant || !charging) {
      report.dataComplete = false;
      report.status = 'incomplete';
    }
  }
  return report;
}
module.exports = { checkReadiness };
