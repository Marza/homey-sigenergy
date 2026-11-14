'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homey-css-'));
try {
  const output = path.join(directory, 'styles.css');
  execFileSync(
    process.execPath,
    [
      path.join(path.dirname(require.resolve('@tailwindcss/cli/package.json')), 'dist/index.mjs'),
      '-i',
      'settings/tailwind.css',
      '-o',
      output,
      '--minify',
    ],
    { stdio: 'inherit' },
  );
  if (!fs.readFileSync(output).equals(fs.readFileSync('settings/styles.css')))
    throw new Error('Settings CSS is stale. Run npm run build:css and commit settings/styles.css.');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
