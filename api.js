'use strict';
// Manifest routes are authenticated by Homey; none are public.
const { compareEconomicScenarios } = require('./lib/pricing/economic-comparison');
const { exportBackup, previewBackup, restoreBackup } = require('./lib/history-backup');
module.exports = {
  async previewEconomics({ homey, body }) {
    return compareEconomicScenarios(body, homey.settings.get('costContract'));
  },
  async previewCharging({ homey, body }) {
    return homey.app.getChargingPreview(body);
  },
  async exportHistory({ homey }) {
    return exportBackup(homey);
  },
  async previewHistoryImport({ homey, body }) {
    return previewBackup(homey, body);
  },
  async importHistory({ homey, body }) {
    return restoreBackup(homey, body);
  },
};
