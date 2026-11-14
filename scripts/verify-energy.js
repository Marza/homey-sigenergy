'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
function verifyEnergy(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'app.json')));
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
