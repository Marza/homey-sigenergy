'use strict';
const Homey = require('homey');
const { TibberHistoryPrices } = require('./lib/pricing/tibber-history-prices');
const { randomUUID, createHash } = require('node:crypto');
const { diagnostics, nibeKey, batteryValues, backupAdvisory } = require('./lib/diagnostics');
const { temperatureContext } = require('./lib/optimization/temperature');
const { DEFAULT_OPERATION, resolveOperation } = require('./lib/operation-mode');
const { HouseholdForecast } = require('./lib/energy/household-forecast');
const { HistoryStore, calculationSlots } = require('./lib/history');
const { DataDiagnostics } = require('./lib/data-diagnostics');
const { validateState: validateMeterHistory } = require('./lib/pricing/consumption-history');
const { calculateDemandCharge, validateTariff } = require('./lib/demand-tariff');
const { SmoS40Reader } = require('./lib/nibe/smo-s40');
const { heatPumpPolicy } = require('./lib/backup/heat-pump-policy');
const {
  readArchive,
  replaceMonth,
  monthKey,
  shiftMonth,
} = require('./lib/pricing/consumption-archive');
const { fetchConsumption, shouldSync } = require('./lib/pricing/consumption-sync');
const { fetchTibberPrices } = require('./lib/pricing/tibber');
const { shouldRefreshPrices, hasTomorrowPrices } = require('./lib/pricing/refresh-policy');
const { historySettings } = require('./lib/packed-history');
const { GridDay } = require('./lib/energy/grid-day');
module.exports = class SigenergyApp extends Homey.App {
  async onInit() {
    // Read-only is enforced in code, not only through a UI toggle.
    this.homey.settings.set(
      'operationMode',
      resolveOperation(this.homey.settings.get('operationMode') || DEFAULT_OPERATION),
    );
    const previousTibber = this.homey.settings.get('sourceConfig')?.tibber;
    this.homey.settings.set('sourceConfig', previousTibber ? { tibber: previousTibber } : {});
    this.homey.settings.set('backupStatus', null);
    this.homey.settings.set('gridPhaseCurrent', null);
    this.homey.settings.set('inverterPhaseCurrent', null);
    this.configurePrices();
    this.dataDiagnostics = new DataDiagnostics(this.homey.settings);
    this.dataDiagnostics.record('app', 'app-started');
    this.history = new HistoryStore(
      historySettings(this.homey.settings),
      () => Date.now(),
      this.dataDiagnostics,
    );
    this.gridDay = new GridDay(this.homey.settings);
    this.forecast = new HouseholdForecast(this.homey.settings, this.history);
    this.refreshDemandEstimate();
    this.demandTimer = this.homey.setInterval(() => this.refreshDemandEstimate(), 15 * 60 * 1000);
    this.refreshForecast();
    this.historyTimer = this.homey.setInterval(() => {
      try {
        this.history.flush();
        this.refreshForecast();
        this.syncBackupAdvisories();
      } catch (e) {
        this.error('History flush:', e.message);
      } finally {
        this.flushGridDay();
        this.dataDiagnostics.flush();
      }
    }, 60 * 1000);
    this.stopping = false;
    this.settingsChanged = (key) => {
      if (['backupStatus', 'sigenergyStatus', 'sigenergyError', 'sourceConfig'].includes(key))
        this.syncBackupAdvisories();
      if (['nibeHost', 'nibePort', 'nibeUnitId', 'nibeAddressOffset'].includes(key))
        this.resetNibeSource();
      if (['tibberToken', 'tibberHomeId'].includes(key)) this.configurePrices();
      if (['tibberConsumptionHistory', 'tibberConsumptionArchive'].includes(key))
        this.refreshDemandEstimate();
      if (key === 'demandTariff') this.refreshDemandEstimate();
    };
    this.homey.settings.on('set', this.settingsChanged);
    this.homey.settings.on('unset', this.settingsChanged);
    this.nibePolling = false;
    this.nibeTimer = this.homey.setInterval(
      () => this.pollNibe().catch((e) => this.error('Nibe:', e.message)),
      60000,
    );
    this.pollNibe().catch((e) => this.log('Nibe monitoring:', e.message));
    this.priceRefreshing = false;
    this.priceTimer = this.homey.setInterval(
      () => {
        if (
          shouldRefreshPrices({
            cache: this.homey.settings.get('priceCache'),
            lastAttemptAt: this.homey.settings.get('priceLastAttemptAt'),
          })
        ) {
          this.refreshPrices().catch((e) => this.error('Tibber refresh:', e.message));
        }
      },
      5 * 60 * 1000,
    );
    // Historical fetches run on timers without delaying startup.
    this.tibberHistoryPrices = new TibberHistoryPrices(this.homey);
    this.tibberHistoryPricesTimer = this.homey.setInterval(
      () => {
        this.tibberHistoryPrices
          .sync()
          .catch(() => this.error('Tibber historical price refresh failed'));
      },
      5 * 60 * 1000,
    );
    this.consumptionTimer = this.homey.setInterval(
      () => this.refreshConsumption().catch(() => this.error('Tibber consumption refresh failed')),
      5 * 60 * 1000,
    );
    await this.refreshPrices().catch((e) => this.log('Price cache not refreshed:', e.message));
    this.log('Sigenergy monitoring and household forecast initialized');
  }
  resetNibeSource() {
    const values = Object.fromEntries(
      ['nibeHost', 'nibePort', 'nibeUnitId', 'nibeAddressOffset'].map((key) => [
        key,
        this.homey.settings.get(key),
      ]),
    );
    this.nibeGeneration = (this.nibeGeneration || 0) + 1;
    const configured = !!String(values.nibeHost || '').trim();
    this.homey.settings.set('sourceConfig', {
      ...this.homey.settings.get('sourceConfig'),
      nibe: {
        configured,
        enabled: configured,
        connectionKey: nibeKey(values),
        since: new Date().toISOString(),
      },
    });
    this.homey.settings.set('nibeStatus', null);
    this.homey.settings.set('nibeError', null);
  }
  async pollNibe() {
    const host = String(this.homey.settings.get('nibeHost') || '').trim();
    if (!host || this.nibePolling) return;
    this.nibePolling = true;
    const values = Object.fromEntries(
      ['nibeHost', 'nibePort', 'nibeUnitId', 'nibeAddressOffset'].map((key) => [
        key,
        this.homey.settings.get(key),
      ]),
    );
    const connectionKey = nibeKey(values);
    const sourceConfig = this.homey.settings.get('sourceConfig') || {};
    if (sourceConfig.nibe?.connectionKey !== connectionKey) this.resetNibeSource();
    const generation = this.nibeGeneration;
    const current = () =>
      !this.stopping &&
      generation === this.nibeGeneration &&
      connectionKey ===
        nibeKey(
          Object.fromEntries(Object.keys(values).map((key) => [key, this.homey.settings.get(key)])),
        );
    let reader;
    try {
      reader = new SmoS40Reader({
        host,
        port: Number(this.homey.settings.get('nibePort')) || 502,
        unitId: Number(this.homey.settings.get('nibeUnitId')) || 1,
        addressOffset: Number(this.homey.settings.get('nibeAddressOffset')) || 0,
      });
      const readings = await reader.snapshot();
      if (!current()) return;
      this.history.observeMinute('outdoorC', readings.outdoorC, reader.outdoorReadAt ?? Date.now());
      const advisory = this.getBackupAdvisory();
      const policy = heatPumpPolicy({
        gridMode: advisory.mode,
        batterySoc: advisory.batterySoc,
        // Do not infer tariff hours: Nibe's existing local schedule stays authoritative.
        tariffActive: false,
      });
      this.homey.settings.set('nibeStatus', {
        readings,
        policy,
        readAt: new Date().toISOString(),
        controlApplied: false,
      });
      this.homey.settings.set('nibeError', null);
    } catch (e) {
      if (!current()) return;
      this.homey.settings.set('nibeError', String(e.message));
      throw e;
    } finally {
      reader?.close();
      this.nibePolling = false;
    }
  }
  configurePrices() {
    const token = String(this.homey.settings.get('tibberToken') || '').trim();
    const homeId = String(this.homey.settings.get('tibberHomeId') || '').trim();
    // Private settings fingerprint binds the random cache revision to credentials without exposing either in diagnostics.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([token, homeId]))
      .digest('hex');
    if (
      this.homey.settings.get('tibberConfigFingerprint') !== fingerprint ||
      !this.homey.settings.get('sourceConfig')?.tibber?.revision
    ) {
      this.priceGeneration = (this.priceGeneration || 0) + 1;
      this.homey.settings.set('sourceConfig', {
        ...this.homey.settings.get('sourceConfig'),
        tibber: { revision: randomUUID() },
      });
      this.homey.settings.set('tibberConfigFingerprint', fingerprint);
      this.homey.settings.set('priceError', null);
    }
    this.homey.settings.set('priceLastAttemptAt', null);
  }
  async refreshPrices() {
    if (this.priceRefreshing) return;
    const token = this.homey.settings.get('tibberToken');
    if (!token) return;
    this.priceRefreshing = true;
    const generation = this.priceGeneration;
    const revision = this.homey.settings.get('sourceConfig')?.tibber?.revision;
    const current = () => !this.stopping && generation === this.priceGeneration;
    this.homey.settings.set('priceLastAttemptAt', new Date().toISOString());
    try {
      const result = await fetchTibberPrices({
        token,
        homeId: this.homey.settings.get('tibberHomeId') || undefined,
      });
      if (!current()) return;
      this.homey.settings.set('priceCache', {
        ...result,
        ...(revision ? { configRevision: revision } : {}),
      });
      this.homey.settings.set('priceTomorrowAvailable', hasTomorrowPrices(result));
      this.homey.settings.set('priceError', null);
    } catch (e) {
      if (!current()) return;
      const message = String(e.message).split(token).join('[redacted]');
      this.homey.settings.set('priceError', message);
      // eslint-disable-next-line preserve-caught-error -- An upstream cause may contain the token that was just redacted.
      throw new Error(message);
    } finally {
      this.priceRefreshing = false;
    }
  }
  getBackupAdvisory(now = Date.now()) {
    return backupAdvisory(
      Object.fromEntries(
        ['backupStatus', 'sourceConfig', 'sigenergyStatus', 'sigenergyError'].map((key) => [
          key,
          this.homey.settings.get(key),
        ]),
      ),
      now,
    );
  }
  syncBackupAdvisories() {
    const advisory = this.getBackupAdvisory();
    const key =
      advisory.status + advisory.mode + (advisory.batterySoc !== null && advisory.batterySoc < 25);
    if (key === this.backupAdvisoryKey) return;
    this.backupAdvisoryKey = key;
    const nibe = this.homey.settings.get('nibeStatus');
    if (nibe)
      this.homey.settings.set('nibeStatus', {
        ...nibe,
        policy: heatPumpPolicy({
          gridMode: advisory.mode,
          batterySoc: advisory.batterySoc,
        }),
      });
  }
  refreshForecast() {
    try {
      this.forecast.refresh();
    } catch (error) {
      this.error('Household forecast:', error.message);
    }
  }
  async refreshConsumption(now = new Date()) {
    if (this.consumptionRefreshing || this.stopping) return;
    const settings = this.homey.settings;
    const token = settings.get('tibberToken');
    const homeId = settings.get('tibberHomeId') || undefined;
    const revision = settings.get('sourceConfig')?.tibber?.revision;
    const previous = settings.get('tibberConsumptionSync');
    if (!shouldSync({ now, token, revision, sync: previous })) return;
    this.consumptionRefreshing = true;
    const current = () =>
      !this.stopping &&
      settings.get('sourceConfig')?.tibber?.revision === revision &&
      settings.get('tibberToken') === token &&
      (settings.get('tibberHomeId') || undefined) === homeId;
    const sync = {
      configRevision: revision,
      lastAttemptAt: now.toISOString(),
      lastSuccessAt: previous?.configRevision === revision ? previous.lastSuccessAt : null,
      status: 'updating',
    };
    try {
      settings.set('tibberConsumptionSync', sync);
      let failed = false;
      let fetchedCurrent = false;
      for (const month of [monthKey(now), shiftMonth(monthKey(now), -1)]) {
        try {
          const state = await fetchConsumption({
            token,
            homeId,
            configRevision: revision,
            now,
            month,
          });
          if (!current()) return;
          if (state) {
            // Read at commit time so a concurrent restore cannot lose other archived months.
            const archive = replaceMonth(readArchive(settings, now), state, now);
            settings.set('tibberConsumptionArchive', archive);
            if (month === monthKey(now)) fetchedCurrent = true;
          }
        } catch {
          if (!current()) return;
          failed = true;
        }
      }
      if (!current()) return;
      settings.set('tibberConsumptionSync', {
        ...sync,
        status: failed ? 'error' : fetchedCurrent ? 'ok' : 'waiting',
        lastSuccessAt: !failed && fetchedCurrent ? now.toISOString() : sync.lastSuccessAt,
      });
      this.refreshDemandEstimate();
    } catch {
      if (current()) {
        settings.set('tibberConsumptionSync', { ...sync, status: 'error' });
        this.refreshDemandEstimate();
      }
    } finally {
      this.consumptionRefreshing = false;
    }
  }
  refreshDemandEstimate(slots) {
    try {
      const tariff = this.homey.settings.get('demandTariff');
      if (!tariff) {
        this.homey.settings.set('demandEstimate', { status: 'not-configured' });
        this.homey.settings.set('meterDemandEstimate', { status: 'not-configured' });
        return;
      }
      const month = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Stockholm',
        year: 'numeric',
        month: '2-digit',
      }).format(new Date());
      this.homey.settings.set('demandEstimate', this.getDemandCharge(month, slots));
      this.homey.settings.set('meterDemandEstimate', this.getMeterDemandCharge(month));
    } catch (error) {
      this.homey.settings.set('demandEstimate', { status: 'error', reason: String(error.message) });
      this.homey.settings.set('meterDemandEstimate', { status: 'error' });
    }
  }
  getDiagnostics() {
    return diagnostics(this.homey.settings);
  }
  getTemperatureContext() {
    const nibe = this.homey.settings.get('nibeStatus');
    const telemetry = this.homey.settings.get('batteryTelemetry');
    const status = this.getDiagnostics();
    const v = batteryValues(telemetry, status.battery);
    return temperatureContext({
      outdoorC: status.nibe.usable ? nibe?.readings?.outdoorC : undefined,
      outdoorObservedAt: nibe?.readAt,
      batteryC: v.batteryTemperatureC,
      chargeLimitKW: v.chargePowerLimitKW,
      dischargeLimitKW: v.dischargePowerLimitKW,
      observedAt: telemetry?.readAt,
    });
  }
  getMeterDemandCharge(month) {
    let state;
    try {
      state = readArchive(this.homey.settings)?.months.find((e) => e.month === month)?.state;
    } catch {
      return { status: 'invalid-meter-history' };
    }
    const revision = this.homey.settings.get('sourceConfig')?.tibber?.revision;
    const tariff = this.homey.settings.get('demandTariff');
    if (!tariff) return { status: 'not-configured' };
    if (!state) return { status: 'no-meter-history' };
    if (!revision || state.configRevision !== revision) return { status: 'configuration-changed' };
    try {
      validateMeterHistory(state);
    } catch {
      return { status: 'invalid-meter-history' };
    }
    if (Date.parse(state.fetchedAt) > Date.now()) return { status: 'invalid-time' };
    return {
      ...calculateDemandCharge([], tariff, month, { meterHours: state.hours }),
      fetchedAt: state.fetchedAt,
    };
  }
  getDemandCharge(month, slots) {
    const tariff = this.homey.settings.get('demandTariff');
    if (!tariff) return { status: 'not-configured' };
    validateTariff(tariff);
    return calculateDemandCharge(slots ?? calculationSlots(this.history), tariff, month);
  }
  flushGridDay() {
    try {
      this.gridDay?.flush();
    } catch (error) {
      this.error('Grid history flush:', error.message);
    }
  }
  async onUninit() {
    this.dataDiagnostics?.record('app', 'app-stopped');
    this.stopping = true;
    this.tibberHistoryPrices?.stop();
    if (this.tibberHistoryPricesTimer) this.homey.clearInterval(this.tibberHistoryPricesTimer);
    if (this.settingsChanged) {
      this.homey.settings.removeListener('set', this.settingsChanged);
      this.homey.settings.removeListener('unset', this.settingsChanged);
    }
    if (this.demandTimer) this.homey.clearInterval(this.demandTimer);
    if (this.historyTimer) this.homey.clearInterval(this.historyTimer);
    if (this.priceTimer) this.homey.clearInterval(this.priceTimer);
    if (this.consumptionTimer) this.homey.clearInterval(this.consumptionTimer);
    if (this.nibeTimer) this.homey.clearInterval(this.nibeTimer);
    this.flushGridDay();
    if (this.history) this.history.flush();
  }
};
