'use strict';
// Manifest routes are authenticated by Homey; none are public.
const { exportBackup, previewBackup, restoreBackup } = require('./lib/history-backup');
const {
  timelineStatus,
  publishContract,
  restoreTimeline,
} = require('./lib/pricing/contract-timeline');
const { getEnergyHistory } = require('./lib/pricing/energy-history');
const { getCounterDiagnostics } = require('./lib/energy/diagnostics');
module.exports = {
  async getGridDay({ homey, body }) {
    const source = homey.settings.get('gridPhaseCurrent');
    return {
      ...homey.app.gridDay.report(source?.binding, body?.metric, body?.phase),
      profile: source?.profile ?? null,
    };
  },
  async getHouseholdForecast({ homey }) {
    return homey.app.forecast.report();
  },
  async getDataDiagnostics({ homey, body }) {
    return homey.app.dataDiagnostics.report(homey, body);
  },
  async getContractTimeline({ homey }) {
    return timelineStatus(homey);
  },
  async publishCostContract({ homey, body }) {
    return publishContract(homey, body);
  },
  async restoreCostContracts({ homey, body }) {
    return restoreTimeline(homey, body);
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
  async getEnergyCounters({ homey }) {
    return getCounterDiagnostics(homey);
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
