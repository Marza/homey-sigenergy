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

for (const widget of Object.keys(require('../app.json').widgets)) {
  for (const asset of ['widget-layout.js', 'widget-layout.css'])
    fs.copyFileSync(`lib/${asset}`, `widgets/${widget}/public/${asset}`);
}

for (const asset of ['history-widget.js', 'history-widget.css'])
  fs.copyFileSync(`widgets/energy-flow/public/${asset}`, `widgets/power-history/public/${asset}`);

fs.copyFileSync('lib/pricing/cost-model.js', 'settings/cost-model.js');
