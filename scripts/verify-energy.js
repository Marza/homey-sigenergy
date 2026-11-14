'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
function verifyEnergy(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'app.json')));
  const reporting = require(path.resolve(directory, 'lib/energy/reporting'));
  assert.equal(typeof reporting.createDevice, 'function');
  assert.equal(typeof reporting.createDriver, 'function');
  for (const role of ['grid', 'solar', 'battery']) {
    const id = 'energy-' + role,
      driver = manifest.drivers.find((d) => d.id === id);
    assert.ok(driver, `Energy driver missing: ${id}`);
    assert.ok(driver.capabilities.includes('measure_power'));
    assert.ok(!driver.capabilities.some((c) => /^(target_power|onoff|meter_power)/.test(c)));
    for (const file of ['driver.js', 'device.js', 'assets/icon.svg'])
      assert.ok(
        fs.existsSync(path.join(directory, 'drivers', id, file)),
        `Energy file missing: ${id}/${file}`,
      );
  }
}
if (require.main === module) verifyEnergy(process.argv[2] || '.homeybuild');
module.exports = { verifyEnergy };
