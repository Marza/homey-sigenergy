'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
function verifyWidget(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'app.json')));
  const widget = manifest.widgets?.['energy-overview'];
  assert.ok(widget, 'Energy overview missing from manifest');
  assert.deepEqual(widget.api, { getOverview: { method: 'GET', path: '/' } });
  for (const file of [
    'api.js',
    'public/index.html',
    'public/source-status.js',
    'public/price-coverage.js',
    'public/tariff-config.js',
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
}
if (require.main === module) verifyWidget(process.argv[2] || '.homeybuild');
module.exports = { verifyWidget };
