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
  getHistoryOverview({ homey }) {
    const { slots, daily, legacyDaily } = homey.app.history.read();
    return {
      slots: slots.slice(-32).map(({ t, counts, sum }) => ({ t, counts, sum })),
      slotCount: slots.length,
      dayCount: daily.length,
      legacyDayCount: legacyDaily.length,
    };
  },
  async getGridDay({ homey, body }) {
    const source = homey.settings.get('gridPhaseCurrent');
    return {
      ...homey.app.gridDay.report(source?.binding, body?.metric, body?.phase),
      profile: source?.profile ?? null,
    };
  },
  getSolarForecast({ homey, query }) {
    return homey.app.solarForecast.report(query?.issued);
  },
  configureSolarForecast({ homey, body }) {
    const config = homey.app.solarForecast.configure(body);
    homey.app.refreshSolarForecast();
    return config;
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
