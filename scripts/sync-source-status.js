'use strict';
const fs = require('node:fs');
for (const [source, name] of [
  ['lib/source-status.js', 'source-status.js'],
  ['lib/pricing/coverage.js', 'price-coverage.js'],
  ['lib/tariff-config.js', 'tariff-config.js'],
]) {
  for (const directory of ['settings', 'widgets/energy-overview/public'])
    fs.copyFileSync(source, `${directory}/${name}`);
}

fs.copyFileSync('lib/optimization/simulator.js', 'settings/simulator.js');

fs.copyFileSync('lib/charging/planner.js', 'settings/charging-planner.js');

fs.copyFileSync('lib/widget-layout.js', 'widgets/energy-overview/public/widget-layout.js');

fs.copyFileSync('lib/pricing/cost-model.js', 'settings/cost-model.js');
