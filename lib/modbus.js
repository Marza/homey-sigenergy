'use strict';
const ModbusRTU = require('modbus-serial');

// V2.5 plant input registers, unit 247. Positive grid = import.
// Positive ESS = charging. 32-bit words are big-endian.
const REGISTERS = Object.freeze({
  gridMode: { address: 30009, signed: false, divisor: 1, count: 1 },
  gridW: { address: 30005, signed: true, divisor: 1 },
  soc: { address: 30014, signed: false, divisor: 10 },
  pvW: { address: 30035, signed: true, divisor: 1 },
  essW: { address: 30037, signed: true, divisor: 1 },
  capacityKWh: { address: 30083, signed: false, divisor: 100 },
});

// Optional plant-level telemetry. Addresses and scaling must be confirmed on hardware.
// Failure of one optional register never invalidates the main plant snapshot.
const OPTIONAL_BATTERY_REGISTERS = Object.freeze({
  chargePowerLimitKW: { address: 30047, count: 2, divisor: 1000 },
  dischargePowerLimitKW: { address: 30049, count: 2, divisor: 1000 },
  availableChargeKWh: { address: 30064, count: 2, divisor: 100 },
  availableDischargeKWh: { address: 30066, count: 2, divisor: 100 },
  nominalChargeKW: { address: 30068, count: 2, divisor: 1000 },
  nominalDischargeKW: { address: 30070, count: 2, divisor: 1000 },
  chargeCutoffSoc: { address: 30085, count: 1, divisor: 10 },
  dischargeCutoffSoc: { address: 30086, count: 1, divisor: 10 },
  soh: { address: 30087, count: 1, divisor: 10 },
});
function validateBatteryTelemetry(values) {
  const result = {};
  for (const [key, value] of Object.entries(values)) {
    const isPercent = /Soc$|^soh$/.test(key);
    if (Number.isFinite(value) && value >= 0 && value <= (isPercent ? 100 : 100000)) result[key] = value;
  }
  if (result.chargeCutoffSoc !== undefined && result.dischargeCutoffSoc !== undefined &&
      result.dischargeCutoffSoc > result.chargeCutoffSoc) {
    delete result.chargeCutoffSoc;
    delete result.dischargeCutoffSoc;
  }
  return result;
}
function decode32(words, signed) {
  if (!Array.isArray(words) || words.length !== 2) throw new Error('Expected two registers');
  const value = ((words[0] << 16) | words[1]);
  return signed ? value : value >>> 0;
}

class SigenergyReader {
  constructor({ host, port = 502, unitId = 247, addressOffset = 0 }) {
    this.client = new ModbusRTU();
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.addressOffset = addressOffset;
    this.connected = false;
  }
  async connect() {
    if (this.connected) return;
    await this.client.connectTCP(this.host, { port: this.port });
    this.client.setID(this.unitId);
    this.client.setTimeout(3000);
    this.connected = true;
  }
  async read(address, count) {
    try {
      await this.connect();
      const result = await this.client.readInputRegisters(address + this.addressOffset, count);
      return result.data;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  async snapshot() {
    const result = {};
    for (const [name, def] of Object.entries(REGISTERS)) {
      const words = await this.read(def.address, def.count || (name === 'soc' ? 1 : 2));
      const raw = (def.count === 1 || name === 'soc') ? words[0] : decode32(words, def.signed);
      result[name] = raw / def.divisor;
    }
    if (result.soc < 0 || result.soc > 100) throw new Error('Invalid SoC');
    return result;
  }
  async batteryTelemetry() {
    const values = {}, errors = {};
    for (const [key, def] of Object.entries(OPTIONAL_BATTERY_REGISTERS)) {
      try {
        const words = await this.read(def.address, def.count);
        values[key] = (def.count === 1 ? words[0] : decode32(words, false)) / def.divisor;
      } catch (error) {
        errors[key] = String(error.message);
      }
    }
    return { values: validateBatteryTelemetry(values), errors, readAt: new Date().toISOString() };
  }
  close() {
    this.connected = false;
    try { this.client.close(); } catch (_) { /* Already closed */ }
  }
}
module.exports = { SigenergyReader, decode32, REGISTERS, OPTIONAL_BATTERY_REGISTERS, validateBatteryTelemetry };
