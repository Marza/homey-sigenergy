'use strict';
const { validateBattery } = require('./balanced-replay');
const Q = 900000,
  H = 3600000,
  EPS = 1e-8;
function replaySolarEv(load, battery, ev, capKW, policy) {
  validateBattery(battery, capKW);
  if (
    !Array.isArray(load) ||
    !load.length ||
    load.length > 672 ||
    !['early', 'home-first', 'ev-first'].includes(policy)
  )
    throw Error('invalid-solar-replay');
  if (
    !Number.isFinite(battery.solarTargetKWh) ||
    battery.solarTargetKWh < battery.initialKWh ||
    battery.solarTargetKWh > battery.capacityKWh
  )
    throw Error('invalid-solar-target');
  const keys = [
    'capacityKWh',
    'initialSoc',
    'targetSoc',
    'efficiency',
    'minPowerKW',
    'maxPowerKW',
    'availableFromHours',
    'deadlineHours',
  ];
  if (
    !ev ||
    !keys.every((k) => Number.isFinite(ev[k])) ||
    ev.capacityKWh <= 0 ||
    ev.capacityKWh > 1000 ||
    ev.initialSoc < 0 ||
    ev.targetSoc < ev.initialSoc ||
    ev.targetSoc > 100 ||
    ev.efficiency <= 0 ||
    ev.efficiency > 1 ||
    ev.minPowerKW < 0 ||
    ev.minPowerKW > ev.maxPowerKW ||
    ev.maxPowerKW <= 0 ||
    ev.maxPowerKW > 350 ||
    ev.availableFromHours < 0 ||
    ev.deadlineHours <= ev.availableFromHours ||
    ev.deadlineHours > load.length * 0.25 ||
    ev.availableFromHours % 0.25 ||
    ev.deadlineHours % 0.25
  )
    throw Error('invalid-ev-task');
  const initialEv = (ev.capacityKWh * ev.initialSoc) / 100,
    targetEv = (ev.capacityKWh * ev.targetSoc) / 100;
  const from = load[0].t,
    arrival = from + ev.availableFromHours * H,
    departure = from + ev.deadlineHours * H;
  let home = battery.initialKWh,
    car = initialEv,
    chargeTotal = 0,
    dischargeTotal = 0,
    homeLosses = 0,
    evInput = 0,
    evLosses = 0,
    uncovered = 0;
  let solarTotal = 0,
    solarHouse = 0,
    solarEv = 0,
    solarHome = 0,
    solarExport = 0,
    balanceResidual = 0;
  const slots = [];
  for (let i = 0; i < load.length; i++) {
    const { t, netLoadKWh, pvKWh } = load[i];
    if (
      !Number.isSafeInteger(t) ||
      t < 0 ||
      t % Q ||
      (i && t !== load[i - 1].t + Q) ||
      !Number.isFinite(netLoadKWh) ||
      Math.abs(netLoadKWh) > 250000 ||
      !Number.isFinite(pvKWh) ||
      pvKWh < 0 ||
      pvKWh > 250000 ||
      netLoadKWh + pvKWh < -EPS
    )
      throw Error('inconsistent-solar-load');
    const netKW = netLoadKWh * 4,
      pvKW = pvKWh * 4,
      surplusKW = Math.min(pvKW, Math.max(0, -netKW));
    const slot = {
      t,
      gridWh: 0,
      importWh: 0,
      exportWh: 0,
      coverageMs: Q,
      directionalCoverageMs: Q,
      chargeKWh: 0,
      dischargeKWh: 0,
      lossKWh: 0,
      evInputKWh: 0,
    };
    let left = 0.25,
      segments = 0;
    while (left > 1e-10) {
      if (++segments > 3) throw Error('solar-segment-limit');
      const remainingAc = Math.max(0, targetEv - car) / ev.efficiency;
      const connected = t >= arrival && t < departure && remainingAc > EPS;
      let evKW = 0;
      if (connected) {
        if (policy === 'early') evKW = ev.maxPowerKW;
        else {
          const futureHours = Math.max(0, (departure - (t + Q)) / H);
          let mandatory = Math.max(0, (remainingAc - ev.maxPowerKW * futureHours) / left);
          if (mandatory > 0) mandatory = Math.max(ev.minPowerKW, mandatory);
          mandatory = Math.min(ev.maxPowerKW, mandatory);
          const homeWant = Math.min(
            battery.maxChargeKW,
            Math.max(0, battery.solarTargetKWh - home) / (battery.chargeEfficiency * left),
          );
          const pvForEv =
            policy === 'home-first'
              ? Math.max(0, surplusKW - mandatory - homeWant)
              : Math.max(0, surplusKW - mandatory);
          evKW = Math.min(ev.maxPowerKW, mandatory + pvForEv);
          if (evKW < ev.minPowerKW - EPS) evKW = mandatory;
          if (evKW < ev.minPowerKW - EPS) evKW = 0;
        }
      }
      // A target can be reached part-way through a quarter at a valid active
      // charging power. The remainder is dispatched separately, not netted away.
      const duration = evKW > 0 ? Math.min(left, remainingAc / evKW) : left;
      if (!(duration > 0)) throw Error('invalid-solar-segment');
      let charged = 0,
        discharged = 0;
      const withEv = netKW + evKW;
      if (policy !== 'early') {
        const peak = Math.max(0, withEv - capKW);
        const useExcess = Math.min(
          Math.max(0, withEv),
          (Math.max(0, home - battery.initialKWh) * battery.dischargeEfficiency) / duration,
        );
        discharged = Math.min(
          Math.max(peak, useExcess),
          battery.maxDischargeKW,
          (Math.max(0, home - battery.reserveKWh) * battery.dischargeEfficiency) / duration,
        );
        if (discharged <= EPS) {
          discharged = 0;
          const pvCharge = Math.min(
            battery.maxChargeKW,
            Math.max(0, -withEv),
            Math.max(0, battery.solarTargetKWh - home) / (battery.chargeEfficiency * duration),
          );
          const restore = Math.max(
            0,
            (battery.initialKWh - home) / (battery.chargeEfficiency * duration) - pvCharge,
          );
          const gridCharge = Math.min(
            Math.max(0, battery.maxChargeKW - pvCharge),
            Math.max(0, capKW - withEv - pvCharge),
            restore,
          );
          charged = pvCharge + gridCharge;
        }
      }
      const evEnergy = evKW * duration,
        chargeEnergy = charged * duration,
        dischargeEnergy = discharged * duration;
      const loss =
        chargeEnergy * (1 - battery.chargeEfficiency) +
        dischargeEnergy * (1 / battery.dischargeEfficiency - 1);
      const grid = (withEv + charged - discharged) * duration;
      home +=
        chargeEnergy * battery.chargeEfficiency - dischargeEnergy / battery.dischargeEfficiency;
      car += evEnergy * ev.efficiency;
      if (
        home < battery.reserveKWh - EPS ||
        home > battery.capacityKWh + EPS ||
        car > targetEv + EPS
      )
        throw Error('storage-boundary-failed');
      const toEv = Math.min(surplusKW, evKW),
        toHome = Math.min(Math.max(0, surplusKW - toEv), charged),
        toExport = Math.max(0, surplusKW - toEv - toHome);
      solarTotal += pvKW * duration;
      solarHouse += (pvKW - surplusKW) * duration;
      solarEv += toEv * duration;
      solarHome += toHome * duration;
      solarExport += toExport * duration;
      balanceResidual +=
        grid - ((netLoadKWh * duration) / 0.25 + evEnergy + chargeEnergy - dischargeEnergy);
      slot.gridWh += grid * 1000;
      slot.importWh += Math.max(0, grid) * 1000;
      slot.exportWh += Math.max(0, -grid) * 1000;
      slot.chargeKWh += chargeEnergy;
      slot.dischargeKWh += dischargeEnergy;
      slot.lossKWh += loss;
      slot.evInputKWh += evEnergy;
      chargeTotal += chargeEnergy;
      dischargeTotal += dischargeEnergy;
      homeLosses += loss;
      evInput += evEnergy;
      evLosses += evEnergy * (1 - ev.efficiency);
      uncovered += Math.max(0, grid - capKW * duration);
      left -= duration;
    }
    slot.storedKWh = home;
    slot.evStoredKWh = car;
    slots.push(slot);
  }
  const batteryResidual = chargeTotal - dischargeTotal - homeLosses - (home - battery.initialKWh);
  const evResidual = evInput - evLosses - (car - initialEv);
  const solarResidual = solarTotal - solarHouse - solarEv - solarHome - solarExport;
  if (
    [batteryResidual, evResidual, solarResidual, balanceResidual].some(
      (n) => !Number.isFinite(n) || Math.abs(n) > 1e-6,
    )
  )
    throw Error('coupled-energy-balance-failed');
  return {
    slots,
    initialKWh: battery.initialKWh,
    finalKWh: home,
    terminalMatched: Math.abs(home - battery.initialKWh) < 1e-7,
    terminalShortfallKWh: Math.max(0, battery.initialKWh - home),
    terminalExcessKWh: Math.max(0, home - battery.initialKWh),
    chargedKWh: chargeTotal,
    dischargedKWh: dischargeTotal,
    lossesKWh: homeLosses,
    uncoveredKWh: uncovered,
    balanceResidualKWh: batteryResidual,
    ev: {
      initialStoredKWh: initialEv,
      targetStoredKWh: targetEv,
      finalStoredKWh: car,
      inputKWh: evInput,
      storedKWh: car - initialEv,
      lossesKWh: evLosses,
      unmetKWh: Math.max(0, targetEv - car),
      targetMet: Math.abs(targetEv - car) < 1e-7,
      availableFromHours: ev.availableFromHours,
      deadlineHours: ev.deadlineHours,
    },
    solar: {
      generationKWh: solarTotal,
      toHouseKWh: solarHouse,
      toEvKWh: solarEv,
      toHomeKWh: solarHome,
      exportKWh: solarExport,
      evNonSolarKWh: Math.max(0, evInput - solarEv),
    },
    conservation: {
      batteryResidualKWh: batteryResidual,
      evResidualKWh: evResidual,
      solarResidualKWh: solarResidual,
      gridResidualKWh: balanceResidual,
    },
  };
}
module.exports = { replaySolarEv };
