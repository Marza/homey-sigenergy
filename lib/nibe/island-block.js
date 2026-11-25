'use strict';
const { SmoS40Reader } = require('./smo-s40');
const { nibeKey } = require('../source-status');

const DELAY_MS = 5 * 60000;
const TARIFF_BLOCK = 19;
const OWNER = 'nibeIslandOwner';
const ENABLED = 'nibeIslandEndpoint';
const KEYS = ['nibeHost', 'nibePort', 'nibeUnitId', 'nibeAddressOffset'];

function endpointKey(settings) {
  return nibeKey(Object.fromEntries(KEYS.map((key) => [key, settings.get(key)])));
}

// S-series Modbus AUX, firmware >= 2.4.3. No configurable write addresses.
class ProductionAux extends SmoS40Reader {
  constructor(key) {
    const [host, port, unitId, offset] = JSON.parse(key);
    if (!host || offset !== 0)
      throw new Error('Nibe-styrning kräver en anslutning med registeroffset 0.');
    super({ host, port, unitId });
    this.client.setTimeout(3000);
  }
  async state() {
    const { data } = await this.client.readHoldingRegisters(2740, 2);
    if (data?.length !== 2 || ![0, 1].includes(data[1])) throw new Error('Ogiltigt AUX-svar.');
    return { selector: data[0], active: data[1] };
  }
  async pumpOn() {
    const { data } = await this.client.readInputRegisters(1066, 1);
    return data?.length === 1 && data[0] === 1;
  }
  selectBlock() {
    return this.client.writeRegister(2740, TARIFF_BLOCK);
  }
  clearSelection() {
    return this.client.writeRegister(2740, 0);
  }
  switchBlock(on) {
    return this.client.writeRegister(2741, on ? 1 : 0);
  }
}

class NibeIslandBlock {
  constructor(settings, getGridMode, open = (key) => new ProductionAux(key)) {
    this.settings = settings;
    this.getGridMode = getGridMode;
    this.open = open;
  }
  intent() {
    const endpoint = endpointKey(this.settings);
    if (this.stopping || this.settings.get(ENABLED) !== endpoint) return { status: 'disabled' };
    const backup = this.settings.get('backupStatus');
    const raw = this.settings.get('sigenergyStatus')?.gridMode;
    if (
      this.getGridMode() !== 'off-grid' ||
      backup?.observed !== 'off-grid' ||
      ![1, 2].includes(raw)
    )
      return { status: 'standby' };
    if (!Number.isFinite(backup.islandSince) || !(backup.islandDurationMs >= DELAY_MS))
      return { status: 'waiting' };
    return { status: 'ready', endpoint, since: backup.islandSince };
  }
  status(state, detail = '') {
    const previous = this.settings.get('nibeIslandStatus');
    if (
      previous?.state === state &&
      previous.detail === detail &&
      (state === 'disabled' || Date.now() - previous.at < 60000)
    )
      return;
    this.settings.set('nibeIslandStatus', { state, detail, at: Date.now() });
  }
  tick() {
    if (!this.pending)
      this.pending = this.reconcile()
        .catch((e) => this.status('error', e.message))
        .finally(() => {
          this.pending = null;
        });
    return this.pending;
  }
  async stop() {
    this.stopping = true;
    await this.pending;
    await this.tick();
  }
  async release(aux, owner) {
    let state = await aux.state();
    if (state.selector === TARIFF_BLOCK) {
      if (state.active && owner.arming) {
        await aux.switchBlock(false);
        state = await aux.state();
      }
      if (state.selector === TARIFF_BLOCK && state.active && !owner.arming) {
        await this.settings.set(OWNER, null);
        return;
      }
      if (state.selector === TARIFF_BLOCK && state.active)
        throw new Error('Nibe bekräftade inte att spärren släpptes.');
      if (owner.original === 0 && state.selector === TARIFF_BLOCK) {
        await aux.clearSelection();
        state = await aux.state();
        if (state.selector === TARIFF_BLOCK) throw new Error('AUX-valet kunde inte återställas.');
      }
    }
    await this.settings.set(OWNER, null);
  }
  async reconcile() {
    const want = this.intent();
    let owner = this.settings.get(OWNER);
    if (!owner && want.status !== 'ready') return this.status(want.status);
    const endpoint = owner?.endpoint ?? want.endpoint;
    const sameOutage = () => {
      const current = this.intent();
      return (
        current.status === 'ready' && current.endpoint === endpoint && current.since === want.since
      );
    };
    if (!owner && this.settings.get('nibeIslandInhibit') === want.since)
      return this.status('inhibited');
    const aux = this.open(endpoint);
    try {
      await aux.connect();
      if (owner) {
        if (owner.confirmed && owner.since === want.since && sameOutage()) {
          const state = await aux.state();
          if (
            state.selector === TARIFF_BLOCK &&
            state.active &&
            (await aux.pumpOn()) &&
            sameOutage()
          )
            return this.status('blocked');
          await this.settings.set('nibeIslandInhibit', owner.since);
        }
        await this.release(aux, owner);
        return this.status(sameOutage() ? 'inhibited' : this.intent().status);
      }
      const initial = await aux.state();
      if (initial.active || ![0, TARIFF_BLOCK].includes(initial.selector))
        return this.status('busy');
      if (!(await aux.pumpOn())) return this.status('pump-off');
      if (!sameOutage()) return this.status(this.intent().status);
      owner = { endpoint, original: initial.selector, since: want.since, confirmed: false };
      await this.settings.set(OWNER, owner);
      if (initial.selector === 0 && sameOutage()) await aux.selectBlock();
      const selected = await aux.state();
      if (selected.selector !== TARIFF_BLOCK || selected.active) {
        // An external change happened before we requested blocking. Leave it alone.
        await this.settings.set(OWNER, null);
        return this.status('busy');
      }
      if (sameOutage()) {
        owner = { ...owner, arming: true };
        await this.settings.set(OWNER, owner);
        if (sameOutage()) await aux.switchBlock(true);
        const applied = await aux.state();
        if (
          applied.selector === TARIFF_BLOCK &&
          applied.active &&
          (await aux.pumpOn()) &&
          sameOutage()
        ) {
          await this.settings.set(OWNER, { ...owner, confirmed: true });
          return this.status('blocked');
        }
      }
      await this.settings.set('nibeIslandInhibit', owner.since);
      await this.release(aux, owner);
      this.status('inhibited');
    } catch (error) {
      if (owner) {
        await this.settings.set('nibeIslandInhibit', owner.since);
        // A timed-out write may have arrived. Keep the journal until release is verified.
        await this.settings.set(OWNER, { ...owner, confirmed: false });
        await this.release(aux, owner);
      }
      throw error;
    } finally {
      aux.close();
    }
  }
}

module.exports = { NibeIslandBlock, ProductionAux, endpointKey };
