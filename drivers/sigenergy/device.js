'use strict';
const Homey = require('homey');
const { SigenergyReader } = require('../../lib/modbus');
const { readFailureReason } = require('../../lib/data-diagnostics');
const { readEvdc, readEvac, validateUnitId } = require('../../lib/charging/modbus-telemetry');
const { PROFILE, sourceKey, solarSourceKey, advance } = require('../../lib/energy/meters');
const { IslandController } = require('../../lib/backup/island-controller');
const {
  phaseReaders,
  closePhaseReaders,
  publishPhaseCurrent,
  pollPhaseCurrent,
} = require('../../lib/energy/phase-reader');
const minuteOf = (ms) => Math.floor(ms / 60000);
const CHARGERS = {
  evdc: {
    read: readEvdc,
    history: { evW: 'powerW' },
    capabilities: { measure_ev_power: 'powerW', measure_ev_soc: 'soc' },
    sourceLabel: 'växelriktarens Modbus-ID (1–246) för EVDC',
  },
  evac: {
    read: readEvac,
    history: { evacW: 'powerW' },
    capabilities: { measure_evac_power: 'powerW', measure_evac_energy: 'totalConsumedKWh' },
    sourceLabel: 'AC-laddarens Modbus-ID (1–246) för EVAC',
  },
};
const chargerValues = (fields, values) =>
  Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, values[field] ?? null]));
module.exports = class SigenergyDevice extends Homey.Device {
  async onInit() {
    this.stopped = false;
    this.island = new IslandController();
    this.lastBackupState = null;
    this.polling = false;
    // Existing paired devices may predate the EVAC capabilities.
    for (const capability of Object.keys(CHARGERS.evac.capabilities)) {
      if (this.hasCapability?.(capability) === false)
        await this.addCapability(capability).catch((error) => this.error(error));
    }
    if (!this.stopped) this.startReader();
  }
  startReader(settings = this.getSettings()) {
    const reason = this.reader ? 'connection-changed' : 'reader-started';
    if (this.timer) this.homey.clearInterval(this.timer);
    if (this.reader) this.reader.close();
    for (const charger of Object.values(this.chargers || {})) charger.reader?.close();
    closePhaseReaders(this.phaseReaders, this.homey);
    this.generation = (this.generation || 0) + 1;
    this.activeSettings = { ...settings };
    this.energySnapshot = null;
    this.energyMeters = null;
    // Do not integrate across a reader/source change, even within one minute.
    this.homey.app?.history?.append(
      { pvW: null, gridW: null, essW: null, evW: null, evacW: null },
      undefined,
      reason,
    );
    this.pollFailure = null;
    this.lastBatteryProbeAt = null;
    this.batterySocMinute = null;
    this.batterySoc = null;
    this.reader = new SigenergyReader(settings);
    const seconds = Math.max(5, Number(settings.pollSeconds) || 10);
    // Allow scheduling jitter while identifying a missed poll in the energy history.
    this.powerGapMs = Math.min(60000, seconds * 1500);
    this.meterGapMs = Math.min(90000, seconds * 1500);
    this.phaseReaders = phaseReaders(settings, seconds);
    for (const [source, entry] of Object.entries(this.phaseReaders))
      publishPhaseCurrent(this.homey, source, entry, entry.state);
    this.island = new IslandController({ maxGapMs: Math.max(30000, seconds * 3000) });
    this.homey.settings.set('backupStatus', null);
    const since = new Date().toISOString();
    const configured = !!String(settings.host || '').trim();
    this.chargers = {};
    const sources = {
      sigenergy: {
        configured,
        enabled: configured,
        since,
        maxAgeMs: Math.max(30000, seconds * 3000),
      },
    };
    sources.household = {
      configured,
      enabled:
        configured &&
        settings.energyMetersProfile === PROFILE &&
        Number(settings.unitId ?? 247) === 247,
      since,
      maxAgeMs: Math.max(30000, seconds * 3000),
    };
    this.householdEnabled = sources.household.enabled;
    this.homey.app?.history?.setHouseholdSource?.(
      this.householdEnabled
        ? sourceKey(settings) + ':' + Number(settings.energyCounterEpoch || 0)
        : null,
    );
    for (const [key, profile] of Object.entries(CHARGERS)) {
      const dedicatedHost = key === 'evac' ? String(settings.evacHost || '').trim() : '';
      const host = dedicatedHost || String(settings.host || '').trim();
      const enabled = !!settings[key + 'Enabled'];
      const unitId = enabled ? validateUnitId(settings[key + 'UnitId']) : null;
      const reader =
        host && unitId !== null
          ? new SigenergyReader({
              host,
              unitId,
              port: dedicatedHost ? 502 : settings.port,
              addressOffset: dedicatedHost ? 0 : settings.addressOffset,
            })
          : null;
      this.chargers[key] = {
        reader,
        polling: false,
        binding:
          sourceKey({ ...settings, host, port: dedicatedHost ? 502 : settings.port, unitId }) +
          ':' +
          Number(settings.energyCounterEpoch || 0),
      };
      sources[key] = {
        configured: !!host,
        enabled,
        since,
        maxAgeMs: Math.max(90000, seconds * 3000),
      };
      this.homey.settings.set(key === 'evdc' ? 'lastEvdc' : 'lastEvac', null);
      this.homey.settings.set(
        key + 'Error',
        enabled && host && !reader ? 'Ange ' + profile.sourceLabel + '.' : null,
      );
    }
    this.updateSources(sources);
    for (const key of [
      'sigenergyStatus',
      'batteryTelemetry',
      'sigenergyError',
      'batteryTelemetryError',
      'householdCounterStatus',
      'householdCounterError',
    ])
      this.homey.settings.set(key, null);
    this.homey.app?.dataDiagnostics?.record('plant', reason);
    const cleared = Promise.all(
      Object.values(CHARGERS).map(({ capabilities }) =>
        this.publishChargerCapabilities(capabilities, {}),
      ),
    );
    const generation = this.generation;
    const current = () => !this.stopped && generation === this.generation;
    const tick = () => {
      this.poll().catch((error) => this.error(error));
      for (const key of Object.keys(CHARGERS))
        this.pollCharger(key).catch((error) => this.error(error));
      for (const [source, entry] of Object.entries(this.phaseReaders))
        pollPhaseCurrent(this.homey, source, entry, current).catch((error) => this.error(error));
    };
    this.timer = this.homey.setInterval(tick, seconds * 1000);
    cleared
      .then(() => {
        if (!this.stopped && generation === this.generation) tick();
      })
      .catch((error) => this.error(error));
  }
  updateSources(sources) {
    this.homey.settings.set('sourceConfig', {
      ...this.homey.settings.get('sourceConfig'),
      ...sources,
    });
  }
  async publishChargerCapabilities(fields, values) {
    await Promise.all(
      Object.entries(chargerValues(fields, values)).map(([id, value]) =>
        this.setCapabilityValue(id, value).catch((error) => this.error(error)),
      ),
    );
  }
  async poll() {
    if (this.stopped) return;
    if (this.polling) {
      const now = Date.now();
      if (Number.isFinite(this.pollStartedAt) && now - this.pollStartedAt > 60000)
        this.homey.app.dataDiagnostics?.record('plant', 'slow-poll', this.pollStartedAt, now);
      return;
    }
    this.polling = true;
    const pollStartedAt = Date.now();
    this.pollStartedAt = pollStartedAt;
    let snapshotRead = false;
    const reader = this.reader,
      generation = this.generation,
      settings = this.activeSettings;
    const current = () => !this.stopped && generation === this.generation;
    try {
      const minute = minuteOf(pollStartedAt);
      const includeSoc = minute !== this.batterySocMinute;
      if (includeSoc) {
        this.batterySocMinute = minute;
        this.batterySoc = null;
      }
      const data = await reader.snapshot(settings.energySolarSource || 'self', includeSoc);
      if (!current()) return;
      snapshotRead = true;
      if (includeSoc && Number.isFinite(data.soc)) {
        const at = data.socReadAt ?? Date.now();
        this.batterySocMinute = minuteOf(at);
        this.batterySoc = data.soc;
        this.homey.app.history?.observeMinute?.('soc', data.soc, at);
      }
      this.energySnapshot = {
        generation: this.generation,
        readAt: Date.now(),
        maxAgeMs: Math.max(30000, (Number(settings.pollSeconds) || 10) * 3000),
        gridW: data.gridW,
        pvW: data.pvW,
        selfPvW: data.selfPvW,
        thirdPartyPvW: data.thirdPartyPvW,
        essW: data.essW,
        soc: this.batterySoc,
        capacityKWh: data.capacityKWh,
        gridMode: data.gridMode,
      };
      const backup = this.island.update(data.gridMode, this.batterySoc);
      this.homey.settings.set('sigenergyStatus', {
        readAt: new Date().toISOString(),
        gridMode: data.gridMode,
      });
      this.homey.settings.set('sigenergyError', null);
      await this.publishBackup(backup);
      if (!current()) return;
      // Optional telemetry is deliberately decoupled from the fast polling loop.
      const now = Date.now();
      if (!this.lastBatteryProbeAt || now - this.lastBatteryProbeAt >= 5 * 60 * 1000) {
        this.lastBatteryProbeAt = now;
        try {
          const optional = await reader.batteryTelemetry();
          if (!current()) return;
          this.homey.settings.set('batteryTelemetryError', null);
          this.homey.settings.set('batteryTelemetry', {
            ...optional,
            values: { ...optional.values, capacityKWh: data.capacityKWh, soc: this.batterySoc },
          });
        } catch (error) {
          if (!current()) return;
          this.homey.settings.set('batteryTelemetryError', error.message);
          this.error('Optional battery probe:', error.message);
        }
      } else {
        const previous = this.homey.settings.get('batteryTelemetry');
        if (previous)
          this.homey.settings.set('batteryTelemetry', {
            ...previous,
            values: { ...previous.values, capacityKWh: data.capacityKWh, soc: this.batterySoc },
          });
      }
      this.homey.app.history?.append(
        {
          gridW: data.gridMode === 0 ? data.gridW : null,
          pvW: data.pvW,
          essW: data.essW,
        },
        undefined,
        data.gridMode === 0 ? 'invalid-sample' : 'off-grid',
        this.powerGapMs,
      );
      await Promise.all([
        this.setCapabilityValue('measure_battery', this.batterySoc),
        this.setCapabilityValue('measure_grid_power', data.gridW),
        this.setCapabilityValue('measure_ess_power', data.essW),
        this.setCapabilityValue('measure_pv_power', data.pvW),
        this.setCapabilityValue('measure_ess_capacity', data.capacityKWh),
      ]);
      if (!current()) return;
      if (settings.energyMetersProfile === PROFILE) {
        let flowMeters, meterReadAt;
        if (this.householdEnabled) {
          try {
            flowMeters = await reader.flowMeterSnapshot();
          } catch {
            /* Older firmware may only support individual counters. */
          }
          if (!current()) return;
          meterReadAt = Date.now();
          this.homey.app.history?.observeFlowMeters?.(
            flowMeters,
            meterReadAt,
            sourceKey(settings) + ':' + Number(settings.energyCounterEpoch || 0),
            this.meterGapMs,
          );
        }
        try {
          const raw = await reader.energyCounters(
            PROFILE,
            settings.energySolarSource || 'self',
            flowMeters,
          );
          if (!current()) return;
          const counterReadAt = flowMeters ? meterReadAt : Date.now();
          const result = advance(this.getStoreValue('energyCounterState'), {
            values: raw.values,
            key: sourceKey(settings),
            solarKey: solarSourceKey(settings),
            epoch: Number(settings.energyCounterEpoch || 0),
            solarEpoch:
              Number(settings.energyCounterEpoch || 0) + Number(settings.energySolarReference || 0),
            now: Date.now(),
          });
          // Persist high-water marks before publishing any new cumulative value.
          await this.setStoreValue('energyCounterState', result.state);
          if (!current()) return;
          this.energyMeters = result;
          try {
            this.homey.app.history?.observeCounters?.(
              {
                ...raw,
                values: Object.fromEntries(
                  Object.entries(raw.values || {}).filter(
                    ([key]) => Number.isFinite(result.values?.[key]) && !result.errors?.[key],
                  ),
                ),
                durationMs: Math.max(raw.durationMs ?? Infinity, counterReadAt - pollStartedAt),
              },
              {
                key: sourceKey(settings) + ':' + Number(settings.energyCounterEpoch || 0),
                solarMode: settings.energySolarSource || 'self',
                solarKey:
                  solarSourceKey(settings) +
                  ':' +
                  Number(settings.energyCounterEpoch || 0) +
                  ':' +
                  Number(settings.energySolarReference || 0),
              },
            );
          } catch {
            this.homey.app.dataDiagnostics?.record('plant', 'counter-recovery-failed');
            this.error('Energy gap recovery unavailable');
          }
        } catch {
          if (!current()) return;
          this.energyMeters = { readAt: Date.now(), values: {}, errors: {} };
          this.error('Optional Energy counter read or persistence failed');
        }
        if (current() && this.householdEnabled)
          await this.pollHouseholdEnergy(reader, current, flowMeters, meterReadAt);
      }
      if (current()) {
        await this.setAvailable();
        if (this.pollFailure) {
          this.homey.app.dataDiagnostics?.record(
            'plant',
            this.pollFailure.reason,
            this.pollFailure.from,
            Date.now(),
          );
          this.pollFailure = null;
        }
      }
    } catch (error) {
      if (!current()) return;
      this.energySnapshot = null;
      const reason = snapshotRead ? 'plant-processing-error' : readFailureReason(error);
      const from = this.pollFailure?.reason === reason ? this.pollFailure.from : pollStartedAt;
      this.pollFailure = { reason, from };
      this.homey.app.dataDiagnostics?.record('plant', reason, from, Date.now());
      this.homey.app.history?.append({ gridW: null, essW: null, pvW: null }, undefined, reason);
      this.homey.settings.set('sigenergyError', String(error.message));
      if (this.householdEnabled) this.noteHouseholdFailure(reason);
      await this.publishBackup(this.island.communicationLost());
      if (!current()) return;
      await this.setUnavailable(`Modbus read failed: ${error.message}`);
    } finally {
      const endedAt = Date.now();
      if (endedAt - pollStartedAt > 60000)
        this.homey.app.dataDiagnostics?.record('plant', 'slow-poll', pollStartedAt, endedAt);
      this.polling = false;
      this.pollStartedAt = null;
    }
  }
  noteHouseholdFailure(reason) {
    this.homey.app.history?.observeHouseholdCounter?.(null, Date.now(), reason);
    this.homey.settings.set('householdCounterStatus', null);
    this.homey.settings.set('householdCounterError', 'Kunde inte läsa husets energiräknare.');
  }
  async pollHouseholdEnergy(reader, current, meters, meterReadAt) {
    try {
      if (meters && !Number.isSafeInteger(meters.house))
        throw Error('Invalid household energy register');
      const raw = meters ? String(meters.house) : await reader.householdEnergyCounter();
      if (!current()) return;
      const at = meters ? meterReadAt : Date.now();
      const averageKW =
        this.homey.app.history?.observeHouseholdCounter?.(raw, at, undefined, this.meterGapMs) ??
        null;
      let powerW = null;
      try {
        powerW = await reader.householdPower();
      } catch {
        /* Optional general-load register. */
      }
      if (!current()) return;
      this.homey.settings.set('householdCounterStatus', {
        powerW,
        totalKWh: Number(raw) / 100,
        averageKW,
        readAt: new Date(at).toISOString(),
      });
      this.homey.settings.set('householdCounterError', null);
    } catch (error) {
      if (current()) this.noteHouseholdFailure(readFailureReason(error));
    }
  }
  async pollCharger(key) {
    const charger = this.chargers[key];
    const { reader } = charger;
    if (this.stopped || !reader || charger.polling) return;
    charger.polling = true;
    const current = () => !this.stopped && this.chargers[key] === charger;
    const profile = CHARGERS[key];
    const started = Date.now();
    try {
      const dc = key === 'evdc';
      const minute = minuteOf(started);
      const includeSoc = dc && minute !== charger.socMinute;
      if (includeSoc) charger.socMinute = minute;
      const {
        values,
        errors = {},
        powerReadAt,
        powerFailure,
        socReadAt,
      } = await profile.read(
        {
          read: (...args) => {
            if (!current()) throw Error('Charger reader replaced');
            return reader.read(...args);
          },
        },
        includeSoc,
      );
      if (!current()) return;
      if (includeSoc) {
        const at = socReadAt ?? powerReadAt;
        charger.socMinute = minuteOf(at);
        charger.soc = values.soc;
        charger.socError = errors.soc;
        this.homey.app.history?.observeMinute?.('evSoc', values.soc, at);
      }
      this.homey.app.history?.append(
        chargerValues(profile.history, values),
        powerReadAt,
        powerFailure ? readFailureReason(powerFailure) : 'invalid-sample',
        this.powerGapMs,
      );
      const totals = dc
        ? { dcIn: values.totalChargedKWh, dcOut: values.totalDischargedKWh }
        : { ac: values.totalConsumedKWh };
      if (Object.values(totals).every(Number.isFinite)) {
        this.homey.app.history?.observeCounters?.(
          {
            durationMs: Date.now() - started,
            values: Object.fromEntries(
              Object.entries(totals).map(([name, kWh]) => [name, String(Math.round(kWh * 100))]),
            ),
          },
          { key: charger.binding },
          dc ? 'ev' : 'evac',
        );
      }
      const liveValues =
        dc && Number.isFinite(charger.soc) ? { ...values, soc: charger.soc } : values;
      this.homey.settings.set(key === 'evdc' ? 'lastEvdc' : 'lastEvac', {
        ...liveValues,
        errors: dc && charger.socError ? { ...errors, soc: charger.socError } : errors,
        readAt: new Date(powerReadAt).toISOString(),
      });
      await this.publishChargerCapabilities(profile.capabilities, liveValues);
    } finally {
      charger.polling = false;
      if (!current()) reader.close();
    }
  }
  getEnergySnapshot() {
    return this.stopped || !this.energySnapshot
      ? null
      : {
          ...this.energySnapshot,
          meterProfile: this.activeSettings?.energyMetersProfile,
          solarSource: this.activeSettings?.energySolarSource || 'self',
          meters: this.energyMeters,
        };
  }
  async publishBackup(backup) {
    this.homey.settings.set('backupStatus', { ...backup, observedAt: new Date().toISOString() });
    if (backup.mode === this.lastBackupState) return;
    this.lastBackupState = backup.mode;
    this.homey.app.history?.event('backup-mode', {
      mode: backup.mode,
      observed: backup.observed,
      requested: backup.nibeModeRequested,
      controlApplied: false,
    });
    this.log('Backup state:', backup.mode, 'EV stop requested:', backup.evStopRequested);
    // Flow trigger is advisory. It does not confirm an EVDC stop or Nibe change.
    const card = this.homey.flow.getTriggerCard('backup_mode_changed');
    await card
      .trigger({
        mode: backup.mode,
        ev_stop_requested: backup.evStopRequested,
        nibe_mode: backup.nibeModeRequested,
      })
      .catch((e) => this.error('Backup flow:', e));
  }
  async onSettings({ newSettings }) {
    this.startReader(newSettings);
  }
  async onDeleted() {
    this.homey.app?.history?.setHouseholdSource?.(null);
    await this.onUninit();
  }
  async onUninit() {
    this.stopped = true;
    this.energySnapshot = null;
    this.energyMeters = null;
    this.generation = (this.generation || 0) + 1;
    const config = this.homey.settings.get('sourceConfig') || {};
    this.updateSources({
      sigenergy: { ...config.sigenergy, enabled: false },
      evdc: { ...config.evdc, enabled: false },
      evac: { ...config.evac, enabled: false },
      household: { ...config.household, enabled: false },
    });
    if (this.timer) this.homey.clearInterval(this.timer);
    if (this.reader) this.reader.close();
    for (const charger of Object.values(this.chargers || {})) charger.reader?.close();
    closePhaseReaders(this.phaseReaders, this.homey);
    this.homey.settings.set('gridPhaseCurrent', null);
    this.homey.settings.set('inverterPhaseCurrent', null);
  }
};
