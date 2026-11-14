'use strict';
// Manifest routes are authenticated by Homey; none are public.
const { compareEconomicScenarios } = require('./lib/pricing/economic-comparison');
const { exportBackup, previewBackup, restoreBackup } = require('./lib/history-backup');
const { getEnergyHistory } = require('./lib/pricing/energy-history');
const { previewSolar } = require('./lib/charging/solar-preview');
const { getCounterDiagnostics } = require('./lib/energy/diagnostics');
module.exports = {
  async getTibberDataStatus({ homey }) {
    return homey.app.tibberData.status();
  },
  async connectTibberData({ homey, body }) {
    return homey.app.tibberData.connect(body);
  },
  async getTibberDataHomes({ homey }) {
    return homey.app.tibberData.homes();
  },
  async selectTibberDataHome({ homey, body }) {
    return homey.app.tibberData.selectHome(body);
  },
  async configureTibberDataComponents({ homey, body }) {
    return homey.app.tibberData.options(body);
  },
  async refreshTibberData({ homey }) {
    return homey.app.tibberData.sync();
  },
  async disconnectTibberData({ homey }) {
    return homey.app.tibberData.disconnect();
  },
  async getObservedCosts({ homey }) {
    return homey.app.tibberData.ledger();
  },
  async getEconomicHistory({ homey }) {
    return getEnergyHistory(homey);
  },
  async previewSolar({ homey, body }) {
    return previewSolar(homey, body);
  },
  async getEnergyCounters({ homey }) {
    return getCounterDiagnostics(homey);
  },
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
