'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const app = JSON.parse(fs.readFileSync('.homeybuild/app.json'));
const pkg = JSON.parse(fs.readFileSync('.homeybuild/package.json'));
if (app.id !== 'com.local.sigenergy.optimizer' || app.version !== pkg.version)
  throw new Error('Unexpected build identity/version');
require('../.homeybuild/node_modules/modbus-serial');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const provenance = {
  version: app.version,
  sourceCommit: commit,
  homeyCli: require('../package.json').devDependencies.homey,
  node: process.version,
};
fs.writeFileSync('.homeybuild/release.json', `${JSON.stringify(provenance, null, 2)}\n`);
fs.mkdirSync('dist', { recursive: true });
const file = `homey-sigenergy-v${app.version}.tar.gz`;
execFileSync('tar', ['-czf', path.resolve('dist', file), '-C', '.homeybuild', '.']);
const sha = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join('dist', file)))
  .digest('hex');
fs.writeFileSync('dist/SHA256SUMS', `${sha}  ${file}\n`);
fs.copyFileSync('docs/release-installation.md', 'dist/INSTALL.md');
console.log(`Packaged ${file} (${fs.statSync(path.join('dist', file)).size} bytes)`);
