'use strict';
const ModbusRTU = require('modbus-serial');
const {
  PROFILE,
  REGISTERS: ENERGY_REGISTERS,
  decodeEnergy,
  SOLAR_SOURCES,
  THIRD_PARTY_SOLAR_REGISTER,
  sumEnergy,
} = require('./energy/meters');

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
    if (Number.isFinite(value) && value >= 0 && value <= (isPercent ? 100 : 100000))
      result[key] = value;
  }
  if (
    result.chargeCutoffSoc !== undefined &&
    result.dischargeCutoffSoc !== undefined &&
    result.dischargeCutoffSoc > result.chargeCutoffSoc
  ) {
    delete result.chargeCutoffSoc;
    delete result.dischargeCutoffSoc;
  }
  return result;
}
// V2.9 table 5-1: own PV 30035 and third-party inverter 30194 are
// distinct S32 signals, gain 1000 kW = one raw watt. No automatic summing.
const THIRD_PARTY_POWER_REGISTER = 30194;
function decodeSolarPower(words) {
  if (
    !Array.isArray(words) ||
    words.length !== 2 ||
    !words.every((word) => Number.isInteger(word) && word >= 0 && word <= 65535)
  )
    return null;
  const value = decode32(words, true);
  return value >= 0 && value <= 10000000 ? value : null;
}
function decode32(words, signed) {
  if (!Array.isArray(words) || words.length !== 2) throw new Error('Expected two registers');
  const value = (words[0] << 16) | words[1];
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
  async read(address, count, timeout = 3000) {
    try {
      await this.connect();
      this.client.setTimeout(timeout);
      const result = await this.client.readInputRegisters(address + this.addressOffset, count);
      return result.data;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  async snapshot(solarSource = 'self') {
    if (!SOLAR_SOURCES.includes(solarSource)) throw new Error('Unsupported solar energy source');
    const result = {};
    for (const [name, def] of Object.entries(REGISTERS)) {
      if (name === 'pvW') {
        try {
          result.selfPvW = decodeSolarPower(await this.read(def.address, 2));
        } catch {
          result.selfPvW = null;
        }
        continue;
      }
      const words = await this.read(def.address, def.count || (name === 'soc' ? 1 : 2));
      const raw = def.count === 1 || name === 'soc' ? words[0] : decode32(words, def.signed);
      result[name] = raw / def.divisor;
    }
    if (result.soc < 0 || result.soc > 100) throw new Error('Invalid SoC');
    result.thirdPartyPvW = null;
    if (solarSource !== 'self' && Number(this.unitId) === 247) {
      try {
        result.thirdPartyPvW = decodeSolarPower(
          await this.read(THIRD_PARTY_POWER_REGISTER, 2, 1000),
        );
      } catch {
        // Selected solar becomes unavailable; retain independently valid plant data.
      }
    }
    const components =
      solarSource === 'self'
        ? [result.selfPvW]
        : solarSource === 'third-party'
          ? [result.thirdPartyPvW]
          : [result.selfPvW, result.thirdPartyPvW];
    result.pvW = components.every(Number.isFinite)
      ? components.reduce((sum, watts) => sum + watts, 0)
      : null;
    if (result.pvW > 10000000) result.pvW = null;
    return result;
  }
  async batteryTelemetry() {
    const values = {},
      errors = {};
    for (const [key, def] of Object.entries(OPTIONAL_BATTERY_REGISTERS)) {
      try {
        const words = await this.read(def.address, def.count);
        values[key] = (def.count === 1 ? words[0] : decode32(words, false)) / def.divisor;
      } catch (error) {
        errors[key] = String(error.message);
      }
    }
    const validated = validateBatteryTelemetry(values);
    for (const key of Object.keys(values))
      if (!(key in validated)) errors[key] = 'Invalid optional battery value';
    return { values: validated, errors, readAt: new Date().toISOString() };
  }
  async energyCounters(profile, solarSource = 'self') {
    if (profile !== PROFILE) throw new Error('Unsupported energy counter profile');
    if (!SOLAR_SOURCES.includes(solarSource)) throw new Error('Unsupported solar energy source');
    if (Number(this.unitId) !== 247) throw new Error('Energy counters require plant unit 247');
    const values = {},
      errors = {};
    const entries = Object.entries(ENERGY_REGISTERS);
    if (solarSource === 'third-party') entries[0] = ['solar', THIRD_PARTY_SOLAR_REGISTER];
    if (solarSource === 'combined')
      entries.splice(1, 0, ['thirdPartySolar', THIRD_PARTY_SOLAR_REGISTER]);
    for (let index = 0; index < entries.length; index++) {
      const [key, address] = entries[index];
      let words;
      try {
        words = await this.read(address, 4, 1000);
      } catch (error) {
        errors[key] = 'unavailable';
        // Stop after transport failure; do not repeat timeouts on an offline optional source.
        if (!Number.isInteger(error?.modbusCode)) {
          for (const [remaining] of entries.slice(index + 1)) errors[remaining] = 'unavailable';
          break;
        }
        continue;
      }
      try {
        values[key] = decodeEnergy(words);
      } catch {
        errors[key] = 'invalid';
      }
    }
    if (solarSource === 'combined') {
      try {
        values.solar = sumEnergy([values.solar, values.thirdPartySolar]);
      } catch {
        delete values.solar;
        errors.solar = 'unavailable';
      }
      delete values.thirdPartySolar;
      delete errors.thirdPartySolar;
    }
    return { values, errors };
  }
  close() {
    this.connected = false;
    try {
      this.client.close();
    } catch (_) {
      /* Already closed */
    }
  }
}
module.exports = {
  SigenergyReader,
  decode32,
  REGISTERS,
  OPTIONAL_BATTERY_REGISTERS,
  validateBatteryTelemetry,
};
