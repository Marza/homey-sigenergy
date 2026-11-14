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
  assert.doesNotMatch(html, /(?:src|href)="https?:/, 'Settings assets must be local');
}
if (require.main === module) verifySettings(process.argv[2] || '.homeybuild');
module.exports = { verifySettings };
