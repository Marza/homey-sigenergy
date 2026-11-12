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
  startReader() {
    if (this.timer) this.homey.clearInterval(this.timer);
    if (this.reader) this.reader.close();
    const settings = this.getSettings();
    this.reader = new SigenergyReader(settings);
    const seconds = Math.max(5, Number(settings.pollSeconds) || 10);
    this.timer = this.homey.setInterval(() => { this.poll().catch(error => this.error(error)); }, seconds * 1000);
    this.poll().catch(error => this.error(error));
  }
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const data = await this.reader.snapshot();
      const backup = this.island.update(data.gridMode, data.soc);
      this.homey.settings.set('sigenergyStatus', { readAt: new Date().toISOString(), gridMode: data.gridMode });
      this.homey.settings.set('sigenergyError', null);
      // Optional telemetry is deliberately decoupled from the fast polling loop.
      const now = Date.now();
      if (!this.lastBatteryProbeAt || now - this.lastBatteryProbeAt >= 5 * 60 * 1000) {
        this.lastBatteryProbeAt = now;
        try {
          const optional = await this.reader.batteryTelemetry();
          this.homey.settings.set('batteryTelemetryError', null);
          this.homey.settings.set('batteryTelemetry', {
            ...optional, values: { ...optional.values, capacityKWh: data.capacityKWh, soc: data.soc },
          });
        } catch (error) { this.homey.settings.set('batteryTelemetryError', error.message); this.error('Optional battery probe:', error.message); }
      } else {
        const previous = this.homey.settings.get('batteryTelemetry');
        if (previous) this.homey.settings.set('batteryTelemetry', {
          ...previous, values: { ...previous.values, capacityKWh: data.capacityKWh, soc: data.soc },
        });
      }
      this.homey.app.history?.append({ gridW: data.gridW, pvW: data.pvW, essW: data.essW, soc: data.soc });
      await this.publishBackup(backup);
      await Promise.all([
        this.setCapabilityValue('measure_battery', data.soc),
        this.setCapabilityValue('measure_grid_power', data.gridW),
        this.setCapabilityValue('measure_ess_power', data.essW),
        this.setCapabilityValue('measure_pv_power', data.pvW),
        this.setCapabilityValue('measure_ess_capacity', data.capacityKWh),
      ]);
      if (this.getSettings().evdcEnabled) {
        try {
          const evdc = await readEvdc(this.reader, {
            powerAddress: Number(this.getSettings().evdcPowerAddress),
            socAddress: Number(this.getSettings().evdcSocAddress),
            powerScale: Number(this.getSettings().evdcPowerScale),
            socScale: Number(this.getSettings().evdcSocScale),
          });
          await this.setCapabilityValue('measure_ev_soc', evdc.soc);
          await this.setCapabilityValue('measure_ev_power', evdc.powerW);
          this.homey.app.history?.append({ evW: evdc.powerW, evSoc: evdc.soc });
          this.homey.settings.set('lastEvdc', { ...evdc, readAt: new Date().toISOString() });
          this.homey.settings.set('evdcError', null);
        } catch (error) {
          this.homey.settings.set('evdcError', error.message);
          this.error('EVDC probe failed:', error.message);
        }
      }
      await this.setAvailable();
    } catch (error) {
      this.homey.settings.set('sigenergyError', String(error.message));
      await this.publishBackup(this.island.communicationLost());
      await this.setUnavailable(`Modbus read failed: ${error.message}`);
    } finally { this.polling = false; }
  }
  async publishBackup(backup) {
    this.homey.settings.set('backupStatus', { ...backup, observedAt: new Date().toISOString() });
    if (backup.mode === this.lastBackupState) return;
    this.lastBackupState = backup.mode;
    this.homey.app.history?.event('backup-mode', { mode: backup.mode, observed: backup.observed, requested: backup.nibeModeRequested, controlApplied: false });
    this.log('Backup state:', backup.mode, 'EV stop requested:', backup.evStopRequested);
    // Flow trigger is advisory. It does not confirm an EVDC stop or Nibe change.
    const card = this.homey.flow.getTriggerCard('backup_mode_changed');
    await card.trigger({ mode: backup.mode, ev_stop_requested: backup.evStopRequested, nibe_mode: backup.nibeModeRequested }).catch(e => this.error('Backup flow:', e));
  }
  async onSettings() { this.startReader(); }
  async onUninit() {
    this.stopped = true;
    if (this.timer) this.homey.clearInterval(this.timer);
    if (this.reader) this.reader.close();
  }
};
