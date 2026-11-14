'use strict';
const { TibberHistoryPrices } = require('../../lib/pricing/tibber-history-prices');
const { timelineStatus, publishContract } = require('../../lib/pricing/contract-timeline');
const { DEFAULTS } = require('../../lib/charging/planner');
const H = 3600000,
  Q = 900000,
  END = Date.parse('2026-06-11T12:00Z');
function fixture({ hours = 4, now = END } = {}) {
  const to = Math.floor(now / H) * H,
    from = to - hours * H;
  const data = {
    tibberToken: 'SECRET_FIXTURE_TOKEN',
    tibberHomeId: 'PRIVATE_FIXTURE_HOME',
    sourceConfig: { tibber: { revision: 'PRIVATE_FIXTURE_REVISION' } },
    chargingConfig: structuredClone(DEFAULTS),
    costContract: {
      schema: 2,
      currency: 'SEK',
      source: 'PRIVATE_FIXTURE_CONTRACT',
      checkedOn: '2026-01-01',
      importPriceBasis: 'spot-ex-vat',
      importIncludesEnergyTax: false,
      energyTaxExVatSekPerKWh: 0.3,
      gridImportExVatSekPerKWh: 0.1,
      otherImportExVatSekPerKWh: 0,
      gridExportBenefitSekPerKWh: 0.04,
      gridExportFeeSekPerKWh: 0,
      vatRate: 0.25,
      batteryWearSekPerKWh: 0,
    },
    demandTariff: {
      start: '00:00',
      end: '23:00',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      peakCount: 1,
      distinctDays: false,
      rateSekPerKw: 40,
    },
  };
  const rows = Array.from({ length: hours * 4 }, (_, i) => ({
    schema: 2,
    t: from + i * Q,
    gridWh: 250,
    importWh: 250,
    exportWh: 0,
    coverageMs: Q,
    directionalCoverageMs: Q,
    essWh: 0,
    essCoverageMs: Q,
    pvWh: 0,
    fieldCoverageMs: { pvW: Q },
  }));
  const homey = {
    settings: {
      get: (key) => data[key],
      set: (key, value) => {
        data[key] = structuredClone(value);
      },
    },
    app: { history: { getSlots: () => rows } },
    drivers: { getDriver: () => ({ getDevices: () => [{}] }) },
  };
  const source = new TibberHistoryPrices(homey, {
    now: () => now,
    fetchImpl: () => {
      throw Error('Network forbidden in fixture');
    },
  });
  homey.app.tibberHistoryPrices = source;
  source.confirm({ confirmSamePlant: true });
  data.tibberHistoryPriceCache = {
    schema: 1,
    revision: source.session().revision,
    fetchedAt: now,
    rows: Array.from({ length: hours }, (_, i) => ({
      t: from + i * H,
      consumption: { price: 1 },
      production: { price: -0.1 },
    })),
  };
  const state = timelineStatus(homey);
  publishContract(
    homey,
    {
      from: '2026-01-01',
      includeNetwork: true,
      confirmEffectiveDate: true,
      confirmTradeComponents: true,
      expectedRevision: state.revision,
      draftHash: state.draftHash,
    },
    now,
  );
  return { homey, data, rows, source, from, to, now, hours };
}
const input = (hours) => ({
  hours: hours || 4,
  capsKW: [2],
  confirmModelAssumptions: true,
  battery: {
    capacityKWh: 10,
    initialKWh: 5,
    reserveKWh: 1,
    maxChargeKW: 3,
    maxDischargeKW: 3,
    chargeEfficiency: 0.9,
    dischargeEfficiency: 0.9,
  },
});
module.exports = { fixture, input, H, Q, END };
