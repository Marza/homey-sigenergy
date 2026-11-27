'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
function verifySettings(directory) {
  const folder = path.join(directory, 'settings');
  const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="styles.css"/);
  assert.match(html, /<script src="navigation.js"/);
  assert.ok(fs.statSync(path.join(folder, 'styles.css')).size > 1000, 'Missing compiled CSS');
  assert.equal(typeof require(path.resolve(folder, 'navigation.js')).bind, 'function');
  assert.match(html, /<script src="settings-assistant.js"/);
  assert.equal(typeof require(path.resolve(folder, 'settings-assistant.js')).bind, 'function');
  assert.match(html, /<script src="data-diagnostics.js"/);
  assert.equal(typeof require(path.resolve(folder, 'data-diagnostics.js')).bind, 'function');
  assert.match(html, /<script src="household-settings.js"/);
  assert.ok(fs.statSync(path.join(folder, 'household-settings.js')).isFile());
  assert.match(html, /household-forecast.js/);
  assert.ok(fs.statSync(path.join(folder, 'solar-forecast.js')).isFile());
  assert.doesNotMatch(
    html,
    /<(?:script|link|img)\b[^>]*\b(?:src|href)="https?:/i,
    'Settings assets must be local',
  );
}
if (require.main === module) verifySettings(process.argv[2] || '.homeybuild');
module.exports = { verifySettings };
