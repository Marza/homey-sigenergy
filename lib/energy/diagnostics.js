'use strict';
const { PROFILE, REGISTERS, SOLAR_SOURCES, projectMeters } = require('./meters');
function energyValues(value) {
  return Object.fromEntries(
    Object.keys(REGISTERS)
      .filter((k) => Number.isFinite(value?.[k]) && value[k] >= 0 && value[k] <= 1e12)
      .map((k) => [k, value[k]]),
  );
}
function getCounterDiagnostics(homey, now = Date.now()) {
  return {
    sources: homey.drivers
      .getDriver('sigenergy')
      .getDevices()
      .map((device) => {
        const snapshot = device.getEnergySnapshot?.();
        const meters = snapshot?.meters;
        return {
          profile: snapshot?.meterProfile === PROFILE ? PROFILE : 'disabled',
          solarSource: SOLAR_SOURCES.includes(snapshot?.solarSource)
            ? snapshot.solarSource
            : 'self',
          readAt: Number.isFinite(meters?.readAt) ? meters.readAt : null,
          powerFresh:
            !!snapshot &&
            Number.isFinite(snapshot.readAt) &&
            Number.isFinite(snapshot.maxAgeMs) &&
            snapshot.readAt <= now &&
            now - snapshot.readAt <= snapshot.maxAgeMs,
          powerReadAt: Number.isFinite(snapshot?.readAt) ? snapshot.readAt : null,
          solarPowerW: Object.fromEntries(
            ['selfPvW', 'thirdPartyPvW', 'pvW']
              .filter(
                (key) =>
                  Number.isFinite(snapshot?.[key]) &&
                  snapshot[key] >= 0 &&
                  snapshot[key] <= 10000000,
              )
              .map((key) => [key, snapshot[key]]),
          ),
          raw: energyValues(meters?.sourceValues),
          published: energyValues(meters?.values),
          status: Object.fromEntries(
            ['grid', 'solar', 'battery'].map((role) => [
              role,
              projectMeters(role, snapshot, now).status,
            ]),
          ),
        };
      }),
  };
}
module.exports = { getCounterDiagnostics };
