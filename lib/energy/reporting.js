'use strict';
// Read-only projection of a fresh plant snapshot. No synthetic energy counters.
const ROLES = ['grid', 'solar', 'battery'];
function project(role, snapshot, now = Date.now()) {
  if (!ROLES.includes(role)) throw Error('Unknown Energy role');
  if (
    !snapshot ||
    !Number.isFinite(snapshot.readAt) ||
    !Number.isFinite(snapshot.maxAgeMs) ||
    snapshot.maxAgeMs <= 0 ||
    snapshot.readAt > now ||
    now - snapshot.readAt > snapshot.maxAgeMs
  )
    return null;
  const key = { grid: 'gridW', solar: 'pvW', battery: 'essW' }[role],
    power = snapshot[key];
  if (
    !Number.isFinite(power) ||
    Math.abs(power) > 10000000 ||
    (role === 'solar' && power < 0) ||
    (role === 'grid' && snapshot.gridMode !== 0)
  )
    return null;
  return {
    power,
    ...(role === 'battery'
      ? {
          soc:
            Number.isFinite(snapshot.soc) && snapshot.soc >= 0 && snapshot.soc <= 100
              ? snapshot.soc
              : null,
        }
      : {}),
  };
}
function sourceDevice(homey, sourceId) {
  if (typeof sourceId !== 'string' || !sourceId) return null;
  return (
    homey.drivers
      .getDriver('sigenergy')
      .getDevices()
      .find((device) => device.getData().id === sourceId) || null
  );
}
function createDriver(Homey, role) {
  if (!ROLES.includes(role)) throw Error('Unknown Energy role');
  return class EnergyDriver extends Homey.Driver {
    async onPairListDevices() {
      const paired = new Set(this.getDevices().map((d) => d.getData().sourceId));
      const labels = { grid: 'Grid / Nät', solar: 'Solar / Sol', battery: 'Battery / Batteri' };
      return this.homey.drivers
        .getDriver('sigenergy')
        .getDevices()
        .filter(
          (d) =>
            typeof d.getData().id === 'string' && d.getData().id && !paired.has(d.getData().id),
        )
        .map((d) => ({
          name: `${d.getName()} — ${labels[role]}`,
          data: { id: JSON.stringify([d.getData().id, role]), sourceId: d.getData().id },
        }));
    }
  };
}
function createDevice(Homey, role) {
  if (!ROLES.includes(role)) throw Error('Unknown Energy role');
  return class EnergyDevice extends Homey.Device {
    async onInit() {
      this.energyStopped = false;
      this.energyGeneration = 0;
      this.energyEnabled = this.getSettings().enabled !== false;
      // Clear persisted capability values before a new live source is accepted.
      await this.clearEnergy();
      this.energyTimer = this.homey.setInterval(
        () => this.queueEnergy().catch((e) => this.error(e)),
        5000,
      );
      await this.queueEnergy();
    }
    queueEnergy() {
      if (this.energyStopped) return Promise.resolve();
      if (this.energyQueue) return this.energyQueue;
      const generation = this.energyGeneration;
      const run = Promise.resolve()
        .then(() => this.refreshEnergy(generation))
        .catch(async (error) => {
          await this.clearEnergy().catch(() => {});
          throw error;
        })
        .finally(() => {
          if (this.energyQueue === run) this.energyQueue = null;
        });
      this.energyQueue = run;
      return run;
    }
    async clearEnergy() {
      const results = await Promise.allSettled([
        this.setUnavailable('Energy source unavailable / Energikälla saknas'),
        this.setCapabilityValue('measure_power', null),
        ...(role === 'battery' ? [this.setCapabilityValue('measure_battery', null)] : []),
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    async refreshEnergy(generation) {
      if (this.energyStopped || generation !== this.energyGeneration) return;
      let value = null,
        source,
        snapshot;
      try {
        source = sourceDevice(this.homey, this.getData().sourceId);
        snapshot = source?.getEnergySnapshot?.();
        if (this.energyEnabled) value = project(role, snapshot);
      } catch {
        /* Missing/not-yet-started parent is not a zero-power measurement. */
      }
      if (!value) {
        await this.clearEnergy();
        return;
      }
      const current = () => {
        try {
          return (
            !this.energyStopped &&
            generation === this.energyGeneration &&
            this.energyEnabled &&
            sourceDevice(this.homey, this.getData().sourceId) === source &&
            source.getEnergySnapshot?.()?.generation === snapshot.generation &&
            !!project(role, snapshot)
          );
        } catch {
          return false;
        }
      };
      await this.setCapabilityValue('measure_power', value.power);
      if (!current()) {
        await this.clearEnergy();
        return;
      }
      if (role === 'battery') await this.setCapabilityValue('measure_battery', value.soc);
      if (!current()) {
        await this.clearEnergy();
        return;
      }
      await this.setAvailable();
      if (!current()) await this.clearEnergy();
    }
    async onSettings({ newSettings }) {
      this.energyEnabled = newSettings.enabled !== false;
      this.energyGeneration++;
      await (this.energyQueue || Promise.resolve()).catch(() => {});
      await this.queueEnergy();
    }
    async onDeleted() {
      await this.onUninit();
    }
    async onUninit() {
      this.energyStopped = true;
      this.energyGeneration++;
      if (this.energyTimer) this.homey.clearInterval(this.energyTimer);
      // Wait for any in-flight write, then leave no old live value behind.
      await (this.energyQueue || Promise.resolve()).catch(() => {});
      await this.clearEnergy();
    }
  };
}
module.exports = { ROLES, project, sourceDevice, createDriver, createDevice };
