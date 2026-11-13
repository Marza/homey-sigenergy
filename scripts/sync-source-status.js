'use strict';
const fs = require('node:fs');
for (const [source, name] of [
  ['lib/source-status.js', 'source-status.js'],
  ['lib/pricing/coverage.js', 'price-coverage.js'],
]) {
  for (const directory of ['settings', 'widgets/energy-overview/public'])
    fs.copyFileSync(source, `${directory}/${name}`);
}
