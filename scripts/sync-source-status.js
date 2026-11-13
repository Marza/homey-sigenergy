'use strict';
const fs = require('node:fs');
for (const destination of ['settings/source-status.js', 'widgets/energy-overview/public/source-status.js']) {
  fs.copyFileSync('lib/source-status.js', destination);
}
