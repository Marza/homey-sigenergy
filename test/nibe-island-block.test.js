'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { IslandController } = require('../lib/backup/island-controller');
const { NibeIslandBlock, ProductionAux, endpointKey } = require('../lib/nibe/island-block');

function fixture() {
  let now = 0;
  const grid = new IslandController({ now: () => now, maxGapMs: 30000 });
  const settings = new Map([['nibeHost', 'pump.test']]);
  const key = endpointKey(settings);
  const operations = [];
  const aux = {
    selector: 0,
    active: 0,
    pump: true,
    connect() {},
    close() {},
    async state() {
      return { selector: this.selector, active: this.active };
    },
    async pumpOn() {
      return this.pump;
    },
    async selectBlock() {
      operations.push('select');
      this.selector = 19;
    },
    async clearSelection() {
      operations.push('restore');
      this.selector = 0;
    },
    async switchBlock(on) {
      operations.push(on ? 'block' : 'release');
      this.active = Number(on);
    },
  };
  const controller = () =>
    new NibeIslandBlock(
      settings,
      () => (settings.get('usable') === false ? 'unknown' : grid.mode),
      (endpoint) => {
        assert.equal(endpoint, key);
        return aux;
      },
    );
  const app = controller();
  const observe = (at, raw) => {
    now = at;
    settings.set('sigenergyStatus', { gridMode: raw });
    settings.set('backupStatus', grid.update(raw, 55));
  };
  const island = () => {
    for (let at = 0; at <= 300000; at += 10000) observe(at, 1);
  };
  const enable = () => settings.set('nibeIslandEndpoint', key);
  return { settings, operations, aux, app, controller, observe, island, enable, key };
}

test('requires opt-in and five minutes of actual uninterrupted island observations', async () => {
  const f = fixture();
  f.island();
  await f.app.tick();
  assert.deepEqual(f.operations, []);
  f.enable();
  f.observe(300001, 0);
  await f.app.tick();
  for (let t = 310000; t < 610000; t += 10000) {
    f.observe(t, 2);
    await f.app.tick();
  }
  assert.deepEqual(f.operations, []);
  f.observe(610000, 2);
  await Promise.all([f.app.tick(), f.app.tick()]);
  assert.deepEqual(f.operations, ['select', 'block']);
  await f.app.tick();
  assert.equal(f.settings.get('nibeIslandStatus').state, 'blocked');
  f.observe(620000, 0);
  await f.app.tick();
  assert.deepEqual(f.operations, ['select', 'block', 'release', 'restore']);
});
test('failed polls, gaps, rollback, unknown or stale plant status cannot authorize writes', async () => {
  for (const interrupt of [
    (f) => f.observe(299999, null),
    (f) => f.observe(395000, 2),
    (f) => f.observe(200000, 1),
    (f) => f.settings.set('usable', false),
  ]) {
    const f = fixture();
    f.enable();
    f.island();
    interrupt(f);
    await f.app.tick();
    assert.deepEqual(f.operations, []);
  }
});
test('respects other AUX owners and requires a running heating-medium pump', async () => {
  for (const [selector, active, pump] of [
    [3, 0, true],
    [19, 1, true],
    [19, 0, false],
  ]) {
    const f = fixture();
    f.island();
    f.enable();
    Object.assign(f.aux, { selector, active, pump });
    await f.app.tick();
    assert.deepEqual(f.operations, []);
  }
});
test('retains a dedicated selector and releases after opt-out, endpoint change, stale source or shutdown', async () => {
  for (const cause of ['disable', 'endpoint', 'stale', 'stop']) {
    const f = fixture();
    f.island();
    f.enable();
    f.aux.selector = 19;
    await f.app.tick();
    if (cause === 'disable') f.settings.delete('nibeIslandEndpoint');
    if (cause === 'endpoint') f.settings.set('nibeHost', 'different.test');
    if (cause === 'stale') f.settings.set('usable', false);
    if (cause === 'stop') await f.app.stop();
    else await f.app.tick();
    assert.deepEqual(f.operations, ['block', 'release']);
    assert.equal(f.settings.get('nibeIslandOwner'), null);
  }
});
test('pump loss or external override releases only owned AUX and inhibits reactivation', async () => {
  for (const cause of ['pump', 'manual-release', 'reassigned']) {
    const f = fixture();
    f.island();
    f.enable();
    await f.app.tick();
    if (cause === 'pump') f.aux.pump = false;
    if (cause === 'manual-release') f.aux.active = 0;
    if (cause === 'reassigned') f.aux.selector = 4;
    await f.app.tick();
    f.aux.pump = true;
    await f.app.tick();
    assert.equal(f.settings.get('nibeIslandStatus').state, 'inhibited');
    assert.deepEqual(
      f.operations,
      cause === 'pump'
        ? ['select', 'block', 'release', 'restore']
        : cause === 'manual-release'
          ? ['select', 'block', 'restore']
          : ['select', 'block'],
    );
  }
});
test('uncertain write persists across loss of connectivity and is released after restart', async () => {
  const f = fixture();
  f.island();
  f.enable();
  const originalState = f.aux.state;
  const originalSwitch = f.aux.switchBlock;
  f.aux.switchBlock = async function (on) {
    await originalSwitch.call(this, on);
    this.state = async () => {
      throw Error('offline');
    };
    throw Error('ack lost');
  };
  await f.app.tick();
  assert.ok(f.settings.get('nibeIslandOwner'));
  assert.equal(f.aux.active, 1);
  f.aux.state = originalState;
  f.aux.switchBlock = originalSwitch;
  f.settings.delete('backupStatus');
  await f.controller().tick();
  assert.equal(f.aux.active, 0);
  assert.equal(f.aux.selector, 0);
});
test('interrupting enable mid-selection or losing pump feedback at activation rolls back', async () => {
  for (const loss of ['grid', 'pump']) {
    const f = fixture();
    f.island();
    f.enable();
    if (loss === 'grid') {
      const select = f.aux.selectBlock.bind(f.aux);
      f.aux.selectBlock = async () => {
        await select();
        f.observe(310000, 0);
      };
    } else {
      let count = 0;
      f.aux.pumpOn = async () => ++count === 1;
    }
    await f.app.tick();
    assert.equal(f.aux.active, 0);
    assert.equal(f.aux.selector, 0);
    assert.equal(f.operations.includes('block'), loss === 'pump');
  }
});
test('adapter uses documented GP10 and AUX addresses and rejects an offset', async () => {
  assert.throws(() => new ProductionAux(JSON.stringify(['pump.test', 502, 1, -1])));
  const aux = new ProductionAux(JSON.stringify(['pump.test', 502, 1, 0]));
  const writes = [];
  aux.client = {
    readHoldingRegisters: async (a, n) => {
      assert.equal(a, 2740);
      assert.equal(n, 2);
      return { data: [19, 1] };
    },
    readInputRegisters: async (a, n) => {
      assert.equal(a, 1066);
      assert.equal(n, 1);
      return { data: [1] };
    },
    writeRegister: async (a, v) => writes.push([a, v]),
  };
  assert.deepEqual(await aux.state(), { selector: 19, active: 1 });
  assert.equal(await aux.pumpOn(), true);
  await aux.selectBlock();
  await aux.switchBlock(true);
  await aux.switchBlock(false);
  await aux.clearSelection();
  assert.deepEqual(writes, [
    [2740, 19],
    [2741, 1],
    [2741, 0],
    [2740, 0],
  ]);
  aux.client.readHoldingRegisters = async () => ({ data: [0, 65535] });
  await assert.rejects(aux.state());
});
