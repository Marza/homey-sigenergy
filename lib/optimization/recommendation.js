'use strict';
const { compareScenarios } = require('./advanced-simulator');
/** Advisory only. Ranking favours feasible scenarios, then low caps and reserve protection.
 * Not a tariff-accurate cost optimum until hourly peaks and official rules are verified.
 */
function recommend(slots, config, options = {}) {
  const result = compareScenarios(slots, config, options);
  const eligible = result.candidates.filter(
    (x) => x.status === 'illustrative' && x.validSlots >= 8 && x.uncoveredKWh <= 0.001,
  );
  if (!eligible.length)
    return {
      status: 'insufficient-data',
      advisoryOnly: true,
      model: result.model,
      coverage: result.coverage,
      assumptions: result.assumptions,
      reason: 'Ingen genomförbar simulering med tillräcklig historik',
      updatedAt: new Date().toISOString(),
    };
  eligible.sort(
    (a, b) =>
      a.capKW - b.capKW || b.reservePercent - a.reservePercent || a.dischargeKWh - b.dischargeKWh,
  );
  const best = eligible[0];
  return {
    status: 'illustrative',
    advisoryOnly: true,
    capKW: best.capKW,
    reservePercent: best.reservePercent,
    coverageFraction: best.coverageFraction,
    simulatedPeakKW: best.peakKW,
    simulatedDischargeKWh: best.dischargeKWh,
    model: result.model,
    coverage: result.coverage,
    assumptions: result.assumptions,
    tariffVerified: false,
    updatedAt: new Date().toISOString(),
    note: 'Preliminärt scenario, inte fakturakorrekt optimering av konfigurerade timtoppar.',
  };
}
module.exports = { recommend };
