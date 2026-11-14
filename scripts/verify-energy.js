'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
function verifyEnergy(directory) {
  assert.equal(
    typeof require(path.resolve(directory, 'lib/energy/diagnostics')).getCounterDiagnostics,
    'function',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'app.json')));
  assert.deepEqual(manifest.api.previewSolar, {
    method: 'POST',
    path: '/solar/preview',
    public: false,
  });
  assert.equal(
    typeof require(path.resolve(directory, 'lib/charging/solar-preview')).previewSolar,
    'function',
  );
  assert.equal(typeof require(path.resolve(directory, 'settings/solar-preview')).bind, 'function');
  const settingsHtml = fs.readFileSync(path.join(directory, 'settings/index.html'), 'utf8');
  assert.ok(settingsHtml.includes('src="solar-preview.js"'));
  assert.ok(settingsHtml.includes('SolarPreview.bind(Homey)'));
  assert.deepEqual(manifest.api.getEconomicHistory, {
    method: 'GET',
    path: '/economics/energy-history',
    public: false,
  });
  assert.equal(
    typeof require(path.resolve(directory, 'lib/pricing/energy-history')).getEnergyHistory,
    'function',
  );
  for (const name of [
    'getTibberHistoryPriceStatus',
    'confirmTibberHistoryHome',
    'configureTibberHistoryComponents',
    'refreshTibberHistoryPrices',
    'getObservedCosts',
  ]) {
    assert.equal(manifest.api[name].public, false);
    assert.equal(typeof require(path.resolve(directory, 'api'))[name], 'function');
  }
  assert.equal(
    typeof require(path.resolve(directory, 'lib/pricing/tibber-history-prices'))
      .TibberHistoryPrices,
    'function',
  );
  assert.ok(fs.existsSync(path.join(directory, 'settings/tibber-history-prices.js')));
  assert.ok(settingsHtml.includes('TibberHistoryPricesSettings.bind(Homey)'));
  for (const name of [
    'getContractTimeline',
    'publishCostContract',
    'restoreCostContracts',
    'compareBatteryReplay',
    'compareSolarEvReplay',
  ]) {
    assert.equal(manifest.api[name].public, false);
    assert.equal(typeof require(path.resolve(directory, 'api'))[name], 'function');
  }
  assert.equal(
    typeof require(path.resolve(directory, 'lib/optimization/balanced-replay')).replayBattery,
    'function',
  );
  assert.ok(fs.existsSync(path.join(directory, 'settings/economic-replay.js')));
  assert.ok(settingsHtml.includes('EconomicReplaySettings.bind(Homey)'));
  assert.equal(
    typeof require(path.resolve(directory, 'lib/optimization/coupled-solar-replay')).replaySolarEv,
    'function',
  );
  assert.ok(settingsHtml.includes('econ-solar-enabled'));
  const meters = require(path.resolve(directory, 'lib/energy/meters'));
  const reporting = require(path.resolve(directory, 'lib/energy/reporting'));
  assert.equal(typeof reporting.createDevice, 'function');
  assert.equal(typeof reporting.createDriver, 'function');
  for (const role of ['grid', 'solar', 'battery']) {
    const id = 'energy-' + role,
      driver = manifest.drivers.find((d) => d.id === id);
    assert.ok(driver, `Energy driver missing: ${id}`);
    assert.ok(driver.capabilities.includes('measure_power'));
    for (const capability of Object.values(meters.CAPABILITIES[role]))
      assert.ok(driver.capabilities.includes(capability));
    assert.ok(driver.capabilities.includes('measure_energy_status'));
    const expected =
      role === 'grid'
        ? {
            cumulativeImportedCapability: 'meter_power.imported',
            cumulativeExportedCapability: 'meter_power.exported',
          }
        : role === 'solar'
          ? { meterPowerExportedCapability: 'meter_power' }
          : {
              meterPowerImportedCapability: 'meter_power.charged',
              meterPowerExportedCapability: 'meter_power.discharged',
            };
    for (const [property, capability] of Object.entries(expected))
      assert.equal(driver.energy[property], capability);
    assert.ok(!driver.capabilities.some((c) => /^(target_power|onoff)/.test(c)));
    for (const file of ['driver.js', 'device.js', 'assets/icon.svg'])
      assert.ok(
        fs.existsSync(path.join(directory, 'drivers', id, file)),
        `Energy file missing: ${id}/${file}`,
      );
  }
}
if (require.main === module) verifyEnergy(process.argv[2] || '.homeybuild');
module.exports = { verifyEnergy };
