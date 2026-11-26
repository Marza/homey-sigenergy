'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
function verifyWidget(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'app.json')));
  for (const id of Object.keys(manifest.widgets)) {
    const publicDir = path.join(directory, 'widgets', id, 'public');
    for (const asset of ['widget-layout.js', 'widget-layout.css']) {
      assert.deepEqual(
        fs.readFileSync(path.join(publicDir, asset)),
        fs.readFileSync(path.join(__dirname, '..', 'lib', asset)),
        `Stale shared layout in ${id}: ${asset}`,
      );
    }
  }
  const widget = manifest.widgets?.['energy-overview'];
  assert.ok(widget, 'Energy overview missing from manifest');
  assert.deepEqual(widget.api, { getOverview: { method: 'GET', path: '/' } });
  for (const file of [
    'api.js',
    'public/index.html',
    'public/source-status.js',
    'public/price-coverage.js',
    'public/tariff-config.js',
    'public/widget-layout.js',
    'preview-light.png',
    'preview-dark.png',
  ])
    assert.ok(
      fs.existsSync(path.join(directory, 'widgets/energy-overview', file)),
      `Widget file missing: ${file}`,
    );
  assert.equal(
    typeof require(path.resolve(directory, 'widgets/energy-overview/api.js')).getOverview,
    'function',
  );
  for (const [id, route] of [
    ['energy-flow', '/:date/:period'],
    ['power-history', '/:date'],
  ]) {
    const folder = path.join(directory, 'widgets', id);
    assert.deepEqual(manifest.widgets?.[id]?.api, { getHistory: { method: 'GET', path: route } });
    for (const file of [
      'public/index.html',
      'public/history-widget.js',
      'public/history-widget.css',
      'public/widget-layout.js',
      'preview-light.png',
      'preview-dark.png',
    ])
      assert.ok(fs.statSync(path.join(folder, file)).size > 0, `Widget ${id} missing ${file}`);
    assert.equal(typeof require(path.resolve(folder, 'api.js')).getHistory, 'function');
  }
  const batteryDir = path.join(directory, 'widgets/battery-plan');
  assert.deepEqual(manifest.widgets['battery-plan'].api, { getPlan: { method: 'GET', path: '/' } });
  assert.equal(typeof require(path.resolve(batteryDir, 'api.js')).getPlan, 'function');
  for (const file of [
    'public/index.html',
    'public/chart.js',
    'public/chart.css',
    'public/widget-layout.js',
    'preview-light.png',
    'preview-dark.png',
  ])
    assert.ok(fs.statSync(path.join(batteryDir, file)).size > 0);
  for (const asset of ['history-widget.js', 'history-widget.css', 'widget-layout.js']) {
    const read = (id) => fs.readFileSync(path.join(directory, 'widgets', id, 'public', asset));
    assert.deepEqual(
      read('energy-flow'),
      read('power-history'),
      `Widget copies differ for ${asset}`,
    );
  }
}
if (require.main === module) verifyWidget(process.argv[2] || '.homeybuild');
module.exports = { verifyWidget };
