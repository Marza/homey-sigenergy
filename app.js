'use strict';
const Homey = require('homey');
const { randomUUID, createHash } = require('node:crypto');
const { priceStatus, usablePrices } = require('./lib/pricing/coverage');
const { diagnostics, nibeKey, batteryValues } = require('./lib/diagnostics');
const { temperatureContext } = require('./lib/optimization/temperature');
const { DEFAULT_OPERATION, resolveOperation } = require('./lib/operation-mode');
const {
  DEFAULT_OPTIMIZER,
  simulate,
  effectiveBatteryConfig,
} = require('./lib/optimization/simulator');
const { compareScenarios } = require('./lib/optimization/advanced-simulator');
const { recommend } = require('./lib/optimization/recommendation');
const { evaluateTariffScenarios } = require('./lib/optimization/tariff-optimizer');
const { HistoryStore } = require('./lib/history');
const { validateState: validateMeterHistory } = require('./lib/pricing/consumption-history');
const { calculateDemandCharge, validateTariff } = require('./lib/demand-tariff');
const { SmoS40Reader } = require('./lib/nibe/smo-s40');
const { heatPumpPolicy } = require('./lib/backup/heat-pump-policy');
const { DEFAULTS, planCharging } = require('./lib/charging/planner');
const { fetchTibberPrices } = require('./lib/pricing/tibber');
const { shouldRefreshPrices, hasTomorrowPrices } = require('./lib/pricing/refresh-policy');
module.exports = class SigenergyApp extends Homey.App {
  async onInit() {
    // Read-only is enforced in code, not only through a UI toggle.
    this.homey.settings.set(
      'operationMode',
      resolveOperation(this.homey.settings.get('operationMode') || DEFAULT_OPERATION),
    );
    if (this.homey.settings.get('autoBatteryValues') === null)
      this.homey.settings.set('autoBatteryValues', true);
    if (!this.homey.settings.get('optimizerConfig'))
      this.homey.settings.set('optimizerConfig', { ...DEFAULT_OPTIMIZER });
    const previousTibber = this.homey.settings.get('sourceConfig')?.tibber;
    this.homey.settings.set('sourceConfig', previousTibber ? { tibber: previousTibber } : {});
    this.configurePrices();
    this.history = new HistoryStore(this.homey.settings);
    this.recommendationTimer = this.homey.setInterval(
      () => this.refreshRecommendation(),
      15 * 60 * 1000,
    );
    this.refreshRecommendation();
    this.historyTimer = this.homey.setInterval(() => {
      try {
        this.history.flush();
      } catch (e) {
        this.error('History flush:', e.message);
      }
    }, 60 * 1000);
    if (!this.homey.settings.get('chargingConfig'))
      this.homey.settings.set('chargingConfig', JSON.parse(JSON.stringify(DEFAULTS)));
    this.stopping = false;
    this.settingsChanged = (key) => {
      if (['nibeHost', 'nibePort', 'nibeUnitId', 'nibeAddressOffset'].includes(key))
        this.resetNibeSource();
      if (['tibberToken', 'tibberHomeId'].includes(key)) this.configurePrices();
      if (key === 'tibberConsumptionHistory') this.refreshDemandEstimate();
      if (key === 'demandTariff') {
        this.refreshDemandEstimate();
        this.homey.settings.set('tariffOptimization', {
          status: this.homey.settings.get('demandTariff') ? 'pending' : 'not-configured',
          advisoryOnly: true,
        });
      }
    };
    this.homey.settings.on('set', this.settingsChanged);
    this.homey.settings.on('unset', this.settingsChanged);
    this.nibePolling = false;
    this.nibeTimer = this.homey.setInterval(
      () => this.pollNibe().catch((e) => this.error('Nibe:', e.message)),
      30000,
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
    await this.refreshPrices().catch((e) => this.log('Price cache not refreshed:', e.message));
    this.log('Sigenergy v0.14 initialized; read-only, no Modbus writes');
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
      const backup = this.homey.settings.get('backupStatus');
      const policy = heatPumpPolicy({
        gridMode: backup?.mode || 'unknown',
        batterySoc: backup?.soc,
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
  refreshRecommendation() {
    try {
      const config = effectiveBatteryConfig(
        this.homey.settings.get('optimizerConfig'),
        this.homey.settings.get('batteryTelemetry'),
        {
          autoBatteryValues: this.homey.settings.get('autoBatteryValues') !== false,
          status: this.getDiagnostics().battery,
        },
      );
      this.homey.settings.set(
        'optimizationRecommendation',
        recommend(this.history.getSlots(), config),
      );
      this.refreshDemandEstimate();
      const tariff = this.homey.settings.get('demandTariff');
      if (tariff) {
        const month = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Stockholm',
          year: 'numeric',
          month: '2-digit',
        }).format(new Date());
        this.homey.settings.set(
          'tariffOptimization',
          evaluateTariffScenarios(this.history.getSlots(), config, tariff, month),
        );
      } else {
        this.homey.settings.set('tariffOptimization', {
          status: 'not-configured',
          advisoryOnly: true,
        });
      }
    } catch (error) {
      this.homey.settings.set('tariffOptimization', {
        status: 'error',
        advisoryOnly: true,
        reason: String(error.message),
      });
      this.homey.settings.set('optimizationRecommendation', {
        status: 'error',
        reason: String(error.message),
        advisoryOnly: true,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  refreshDemandEstimate() {
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
      this.homey.settings.set('demandEstimate', this.getDemandCharge(month));
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
  getOptimizationPreview() {
    return simulate(
      this.history.getSlots(),
      effectiveBatteryConfig(
        this.homey.settings.get('optimizerConfig'),
        this.homey.settings.get('batteryTelemetry'),
        {
          autoBatteryValues: this.homey.settings.get('autoBatteryValues') !== false,
          status: this.getDiagnostics().battery,
        },
      ),
    );
  }
  getAdvancedOptimizationPreview(options = {}) {
    return compareScenarios(
      this.history.getSlots(),
      effectiveBatteryConfig(
        this.homey.settings.get('optimizerConfig'),
        this.homey.settings.get('batteryTelemetry'),
        {
          autoBatteryValues: this.homey.settings.get('autoBatteryValues') !== false,
          status: this.getDiagnostics().battery,
        },
      ),
      options,
    );
  }
  getMeterDemandCharge(month) {
    const state = this.homey.settings.get('tibberConsumptionHistory');
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
  getDemandCharge(month) {
    const tariff = this.homey.settings.get('demandTariff');
    if (!tariff) return { status: 'not-configured' };
    validateTariff(tariff);
    return calculateDemandCharge(this.history.getSlots(), tariff, month);
  }
  getPricePlan(currentSoc, now = new Date()) {
    const values = Object.fromEntries(
      [
        'tibberToken',
        'tibberHomeId',
        'sourceConfig',
        'priceCache',
        'priceError',
        'priceLastAttemptAt',
      ].map((key) => [key, this.homey.settings.get(key)]),
    );
    const status = priceStatus(values, now.getTime());
    if (!status.usable)
      return {
        status: status.reason === 'expired-prices' ? 'expired-prices' : 'no-prices',
        pricing: status,
        advisoryOnly: true,
      };
    return {
      fetchedAt: status.fetchedAt,
      currency: status.currency,
      pricing: status,
      advisoryOnly: true,
      ...planCharging({
        now,
        currentSoc,
        config: this.homey.settings.get('chargingConfig'),
        prices: usablePrices(values, now.getTime()),
      }),
    };
  }
  async onUninit() {
    this.stopping = true;
    if (this.settingsChanged) {
      this.homey.settings.removeListener('set', this.settingsChanged);
      this.homey.settings.removeListener('unset', this.settingsChanged);
    }
    if (this.recommendationTimer) this.homey.clearInterval(this.recommendationTimer);
    if (this.historyTimer) this.homey.clearInterval(this.historyTimer);
    if (this.priceTimer) this.homey.clearInterval(this.priceTimer);
    if (this.nibeTimer) this.homey.clearInterval(this.nibeTimer);
    if (this.history) this.history.flush();
  }
};
