'use strict';
// Manifest routes are authenticated by Homey; none are public.
const { compareEconomicScenarios } = require('./lib/pricing/economic-comparison');
const { exportBackup, previewBackup, restoreBackup } = require('./lib/history-backup');
const {
  timelineStatus,
  publishContract,
  restoreTimeline,
} = require('./lib/pricing/contract-timeline');
const { compareReplay } = require('./lib/pricing/replay-comparison');
const { getEnergyHistory } = require('./lib/pricing/energy-history');
const { previewSolar } = require('./lib/charging/solar-preview');
const { getCounterDiagnostics } = require('./lib/energy/diagnostics');
module.exports = {
  async getContractTimeline({ homey }) {
    return timelineStatus(homey);
  },
  async publishCostContract({ homey, body }) {
    return publishContract(homey, body);
  },
  async restoreCostContracts({ homey, body }) {
    return restoreTimeline(homey, body);
  },
  async compareBatteryReplay({ homey, body }) {
    return compareReplay(homey, body);
  },
  async getTibberHistoryPriceStatus({ homey }) {
    return homey.app.tibberHistoryPrices.status();
  },
  async confirmTibberHistoryHome({ homey, body }) {
    return homey.app.tibberHistoryPrices.confirm(body);
  },
  async configureTibberHistoryComponents({ homey, body }) {
    return homey.app.tibberHistoryPrices.options(body);
  },
  async refreshTibberHistoryPrices({ homey }) {
    return homey.app.tibberHistoryPrices.sync();
  },
  async getObservedCosts({ homey }) {
    return homey.app.tibberHistoryPrices.ledger();
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
