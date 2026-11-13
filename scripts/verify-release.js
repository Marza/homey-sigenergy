'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const app = JSON.parse(fs.readFileSync('.homeybuild/app.json'));
const file = `homey-sigenergy-v${app.version}.tar.gz`;
const archive = path.resolve('dist', file);
const expected = fs.readFileSync('dist/SHA256SUMS', 'utf8').trim();
const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
if (expected !== `${digest}  ${file}`) throw new Error('Archive checksum mismatch');
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'homey-release-')));
try {
  execFileSync('tar', ['-xzf', archive, '-C', directory]);
  for (const name of ['test', 'scripts', 'docs', 'dist', '.github', '.env', 'env.json']) {
    if (fs.existsSync(path.join(directory, name)))
      throw new Error(`Unexpected development/config file in archive: ${name}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'app.json')));
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'release.json')));
  if (manifest.version !== app.version || provenance.version !== app.version)
    throw new Error('Archive version mismatch');
  require(path.join(directory, 'node_modules/modbus-serial'));
  // The normal install command performs this same build before uploading to Homey.
  execFileSync(
    process.execPath,
    [path.resolve('node_modules/homey/bin/homey.mjs'), 'app', 'build', '--path', directory],
    { stdio: 'inherit' },
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
