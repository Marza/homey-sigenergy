'use strict';
const Homey = require('homey');
const { SigenergyReader } = require('../../lib/modbus');
const { readEvdc } = require('../../lib/charging/evdc');
const { IslandController } = require('../../lib/backup/island-controller');
module.exports = class SigenergyDevice extends Homey.Device {
  async onInit() {
    this.stopped = false;
    this.island = new IslandController();
    this.lastBackupState = null;
    this.polling = false;
    this.startReader();
  }
  startReader(settings = this.getSettings()) {
    if (this.timer) this.homey.clearInterval(this.timer);
    if (this.reader) this.reader.close();
    this.generation = (this.generation || 0) + 1;
    this.activeSettings = { ...settings };
    this.lastBatteryProbeAt = null;
    this.reader = new SigenergyReader(settings);
    const seconds = Math.max(5, Number(settings.pollSeconds) || 10);
    this.island = new IslandController({ maxGapMs: Math.max(30000, seconds * 3000) });
    this.homey.settings.set('backupStatus', null);
    const since = new Date().toISOString();
    const configured = !!String(settings.host || '').trim();
    this.updateSources({
      sigenergy: {
        configured,
        enabled: configured,
        since,
        maxAgeMs: Math.max(30000, seconds * 3000),
      },
      evdc: {
        configured,
        enabled: configured && !!settings.evdcEnabled,
        since,
        maxAgeMs: Math.max(90000, seconds * 3000),
      },
    });
    for (const key of [
      'sigenergyStatus',
      'batteryTelemetry',
      'lastEvdc',
      'sigenergyError',
      'batteryTelemetryError',
      'evdcError',
    ])
      this.homey.settings.set(key, null);
    const cleared = this.clearEvdc();
    this.timer = this.homey.setInterval(() => {
      this.poll().catch((error) => this.error(error));
    }, seconds * 1000);
    cleared.then(() => this.poll()).catch((error) => this.error(error));
  }
  updateSources(sources) {
    this.homey.settings.set('sourceConfig', {
      ...this.homey.settings.get('sourceConfig'),
      ...sources,
    });
  }
  async clearEvdc() {
    await Promise.all(
      ['measure_ev_soc', 'measure_ev_power'].map((id) =>
        this.setCapabilityValue(id, null).catch((e) => this.error(e)),
      ),
    );
  }
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    const reader = this.reader,
      generation = this.generation,
      settings = this.activeSettings;
    const current = () => !this.stopped && generation === this.generation;
    try {
      const data = await reader.snapshot();
      if (!current()) return;
      const backup = this.island.update(data.gridMode, data.soc);
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
            values: { ...optional.values, capacityKWh: data.capacityKWh, soc: data.soc },
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
            values: { ...previous.values, capacityKWh: data.capacityKWh, soc: data.soc },
          });
      }
      this.homey.app.history?.append({
        gridW: data.gridW,
        pvW: data.pvW,
        essW: data.essW,
        soc: data.soc,
      });
      await Promise.all([
        this.setCapabilityValue('measure_battery', data.soc),
        this.setCapabilityValue('measure_grid_power', data.gridW),
        this.setCapabilityValue('measure_ess_power', data.essW),
        this.setCapabilityValue('measure_pv_power', data.pvW),
        this.setCapabilityValue('measure_ess_capacity', data.capacityKWh),
      ]);
      if (!current()) return;
      if (settings.evdcEnabled) {
        try {
          const evdc = await readEvdc(reader, {
            powerAddress: Number(settings.evdcPowerAddress),
            socAddress: Number(settings.evdcSocAddress),
            powerScale: Number(settings.evdcPowerScale),
            socScale: Number(settings.evdcSocScale),
          });
          if (!current()) return;
          await this.setCapabilityValue('measure_ev_soc', evdc.soc);
          if (!current()) return;
          await this.setCapabilityValue('measure_ev_power', evdc.powerW);
          if (!current()) return;
          this.homey.app.history?.append({ evW: evdc.powerW, evSoc: evdc.soc });
          this.homey.settings.set('lastEvdc', { ...evdc, readAt: new Date().toISOString() });
          this.homey.settings.set('evdcError', null);
        } catch (error) {
          if (!current()) return;
          await this.clearEvdc();
          if (!current()) return;
          this.homey.settings.set('evdcError', error.message);
          this.error('EVDC probe failed:', error.message);
        }
      }
      if (current()) await this.setAvailable();
    } catch (error) {
      if (!current()) return;
      this.homey.settings.set('sigenergyError', String(error.message));
      await this.publishBackup(this.island.communicationLost());
      await this.clearEvdc();
      if (!current()) return;
      await this.setUnavailable(`Modbus read failed: ${error.message}`);
    } finally {
      this.polling = false;
    }
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
    await this.onUninit();
  }
  async onUninit() {
    this.stopped = true;
    this.generation = (this.generation || 0) + 1;
    const config = this.homey.settings.get('sourceConfig') || {};
    this.updateSources({
      sigenergy: { ...config.sigenergy, enabled: false },
      evdc: { ...config.evdc, enabled: false },
    });
    if (this.timer) this.homey.clearInterval(this.timer);
    if (this.reader) this.reader.close();
  }
};
