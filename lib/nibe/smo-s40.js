'use strict';
// Load dependency only when opening a real connection.
// Read-only, explicit register profile: never guess writable Nibe registers.
const DEFAULT_PROFILE = Object.freeze({
  outdoorC: { address: 1, scale: 10, signed: true },
  hotWaterC: { address: 8, scale: 10, signed: true },
  supplyC: { address: 39, scale: 10, signed: true },
  returnC: { address: 88, scale: 10, signed: true },
});
function decode16(value, signed) {
  if (!Number.isInteger(value) || value < 0 || value > 65535)
    throw new Error('Invalid Modbus word');
  return signed && value >= 32768 ? value - 65536 : value;
}
class SmoS40Reader {
  constructor({
    host,
    port = 502,
    unitId = 1,
    addressOffset = 0,
    profile = DEFAULT_PROFILE,
    client,
  } = {}) {
    if (!host && !client) throw new Error('Nibe host required');
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.addressOffset = addressOffset;
    this.profile = profile;
    this.client = client || new (require('modbus-serial'))();
    this.connected = !!client;
  }
  async connect() {
    if (this.connected) return;
    this.client.setTimeout(3000);
    await this.client.connectTCP(this.host, { port: this.port });
    this.client.setID(this.unitId);
    this.connected = true;
  }
  async snapshot() {
    this.errors = {};
    this.firstReadAt = null;
    this.outdoorReadAt = null;
    try {
      await this.connect();
    } catch (error) {
      this.close();
      throw error;
    }
    const readings = {};
    for (const [key, def] of Object.entries(this.profile)) {
      let response;
      try {
        response = await this.client.readInputRegisters(def.address + this.addressOffset, 1);
      } catch (error) {
        this.errors[key] = error?.modbusCode === 2 ? 'unsupported' : 'read-error';
        continue;
      }
      const word = response?.data?.[0];
      if (response?.data?.length !== 1 || !Number.isInteger(word) || word < 0 || word > 65535) {
        this.errors[key] = 'invalid';
        continue;
      }
      const value = decode16(word, def.signed) / def.scale;
      // Application plausibility bounds. Extreme signed words cannot be water temperatures.
      if (!Number.isFinite(value) || value < -50 || value > (key === 'outdoorC' ? 100 : 150)) {
        this.errors[key] = 'invalid';
        continue;
      }
      const at = Date.now();
      this.firstReadAt ??= at;
      if (key === 'outdoorC') this.outdoorReadAt = at;
      readings[key] = value;
    }
    return readings;
  }
  close() {
    this.connected = false;
    try {
      this.client.close();
    } catch {
      /* Connection may already be closed. */
    }
  }
}
module.exports = { DEFAULT_PROFILE, decode16, SmoS40Reader };
