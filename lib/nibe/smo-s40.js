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
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('Invalid Modbus word');
  return signed && value >= 32768 ? value - 65536 : value;
}
class SmoS40Reader {
  constructor({ host, port = 502, unitId = 1, addressOffset = 0, profile = DEFAULT_PROFILE, client } = {}) {
    if (!host && !client) throw new Error('Nibe host required');
    this.host = host; this.port = port; this.unitId = unitId;
    this.addressOffset = addressOffset; this.profile = profile;
    this.client = client || new (require('modbus-serial'))(); this.connected = !!client;
  }
  async connect() {
    if (this.connected) return;
    await this.client.connectTCP(this.host, { port: this.port });
    this.client.setID(this.unitId); this.client.setTimeout(3000); this.connected = true;
  }
  async snapshot() {
    try {
      await this.connect();
      const values = {};
      for (const [key, def] of Object.entries(this.profile)) {
        const response = await this.client.readInputRegisters(def.address + this.addressOffset, 1);
        if (!response?.data || response.data.length !== 1) throw new Error('Invalid Nibe response: ' + key);
        const value = decode16(response.data[0], def.signed) / def.scale;
        if (!Number.isFinite(value)) throw new Error('Invalid Nibe measurement: ' + key);
        values[key] = value;
      }
      return values;
    } catch (error) { this.close(); throw error; }
  }
  close() { this.connected = false; try { this.client.close(); } catch (_) {} }
}
module.exports = { DEFAULT_PROFILE, decode16, SmoS40Reader };
