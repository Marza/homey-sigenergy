'use strict';
const Q = 900000;
function validateBattery(config, capKW) {
  const keys = [
    'capacityKWh',
    'initialKWh',
    'reserveKWh',
    'maxChargeKW',
    'maxDischargeKW',
    'chargeEfficiency',
    'dischargeEfficiency',
  ];
  if (
    !config ||
    !keys.every((k) => Number.isFinite(config[k])) ||
    config.capacityKWh <= 0 ||
    config.capacityKWh > 1000 ||
    config.initialKWh < config.reserveKWh ||
    config.initialKWh > config.capacityKWh ||
    config.reserveKWh < 0 ||
    config.maxChargeKW <= 0 ||
    config.maxChargeKW > 1000 ||
    config.maxDischargeKW <= 0 ||
    config.maxDischargeKW > 1000 ||
    config.chargeEfficiency <= 0 ||
    config.chargeEfficiency > 1 ||
    config.dischargeEfficiency <= 0 ||
    config.dischargeEfficiency > 1 ||
    !Number.isFinite(capKW) ||
    capKW < 0 ||
    capKW > 1000
  )
    throw Error('invalid-battery-assumptions');
}
function replayBattery(load, config, capKW) {
  if (!Array.isArray(load) || !load.length || load.length > 3072)
    throw Error('invalid-replay-window');
  validateBattery(config, capKW);
  let stored = config.initialKWh,
    charged = 0,
    discharged = 0,
    losses = 0,
    uncovered = 0;
  const baseline = [],
    scenario = [];
  for (let i = 0; i < load.length; i++) {
    const { t, netLoadKWh } = load[i];
    if (
      !Number.isSafeInteger(t) ||
      t < 0 ||
      t % Q ||
      (i && t !== load[i - 1].t + Q) ||
      !Number.isFinite(netLoadKWh) ||
      Math.abs(netLoadKWh) > 250000
    )
      throw Error('invalid-replay-interval');
    let charge = 0,
      discharge = 0;
    const required = Math.max(0, netLoadKWh - capKW * 0.25);
    if (required > 0) {
      discharge = Math.min(
        required,
        config.maxDischargeKW * 0.25,
        Math.max(0, stored - config.reserveKWh) * config.dischargeEfficiency,
      );
      stored -= discharge / config.dischargeEfficiency;
      uncovered += required - discharge;
    } else {
      // Restore only energy already used. Cap includes all grid recharge, while
      // solar export can be diverted first. No free external recharge bucket.
      charge = Math.min(
        Math.max(0, capKW * 0.25 - netLoadKWh),
        config.maxChargeKW * 0.25,
        Math.max(0, config.initialKWh - stored) / config.chargeEfficiency,
      );
      stored += charge * config.chargeEfficiency;
    }
    const grid = netLoadKWh + charge - discharge,
      loss =
        charge * (1 - config.chargeEfficiency) + discharge * (1 / config.dischargeEfficiency - 1);
    charged += charge;
    discharged += discharge;
    losses += loss;
    const slot = (energy) => ({
      t,
      gridWh: energy * 1000,
      importWh: Math.max(0, energy) * 1000,
      exportWh: Math.max(0, -energy) * 1000,
      coverageMs: Q,
      directionalCoverageMs: Q,
    });
    baseline.push({
      ...slot(netLoadKWh),
      storedKWh: config.initialKWh,
      chargeKWh: 0,
      dischargeKWh: 0,
      lossKWh: 0,
    });
    scenario.push({
      ...slot(grid),
      storedKWh: stored,
      chargeKWh: charge,
      dischargeKWh: discharge,
      lossKWh: loss,
    });
  }
  const balanceResidualKWh = charged - discharged - losses - (stored - config.initialKWh);
  if (
    Math.abs(balanceResidualKWh) > 1e-7 ||
    stored < config.reserveKWh - 1e-7 ||
    stored > config.capacityKWh + 1e-7
  )
    throw Error('energy-balance-failed');
  return {
    baseline,
    scenario,
    initialKWh: config.initialKWh,
    finalKWh: stored,
    terminalMatched: Math.abs(stored - config.initialKWh) <= 1e-7,
    terminalShortfallKWh: Math.max(0, config.initialKWh - stored),
    chargedKWh: charged,
    dischargedKWh: discharged,
    lossesKWh: losses,
    uncoveredKWh: uncovered,
    balanceResidualKWh,
  };
}
module.exports = { replayBattery, validateBattery };
