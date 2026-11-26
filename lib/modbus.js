'use strict';
const { validAmps } = require('./energy/phase-current');
const { METERS } = require('./energy/meter-flow');
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
    this.unsupportedBlocks = new Set();
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
  // A device may expose individual inputs but reject a longer FC04 request.
  // Remember that exception for this reader only. Retry transient failures next poll.
  async readBlock(address, count) {
    if (this.unsupportedBlocks.has(address)) return null;
    try {
      const words = await this.read(address, count);
      if (!Array.isArray(words) || words.length !== count) throw Error('Incomplete Modbus block');
      return words;
    } catch (error) {
      if (error?.modbusCode !== 2 && error?.modbusCode !== 3) throw error;
      this.unsupportedBlocks.add(address);
      return null;
    }
  }
  async readCapacity() {
    const minute = Math.floor(Date.now() / 60000);
    if (this.capacityMinute !== minute) {
      this.capacityMinute = minute;
      try {
        const raw = decode32(await this.read(REGISTERS.capacityKWh.address, 2), false);
        this.capacityKWh = raw === 0xffffffff ? null : raw / REGISTERS.capacityKWh.divisor;
      } catch {
        this.capacityKWh = null;
      }
    }
    return this.capacityKWh;
  }
  async snapshot(solarSource = 'self', includeSoc = true, sharedGatewayStatus) {
    if (!SOLAR_SOURCES.includes(solarSource)) throw new Error('Unsupported solar energy source');
    const result = {};
    const gateway = await sharedGatewayStatus;
    if (gateway) {
      result.gridMode = gateway.gridMode;
      result.gridW = gateway.gridW;
    } else {
      const grid = await this.readBlock(REGISTERS.gridW.address, 5);
      result.gridMode = grid ? grid[4] : (await this.read(REGISTERS.gridMode.address, 1))[0];
      result.gridW = decode32(
        grid?.slice(0, 2) ?? (await this.read(REGISTERS.gridW.address, 2)),
        true,
      );
    }
    if (includeSoc) {
      result.soc = (await this.read(REGISTERS.soc.address, 1))[0] / REGISTERS.soc.divisor;
      result.socReadAt = Date.now();
    }
    const powers = await this.readBlock(REGISTERS.pvW.address, 4);
    try {
      result.selfPvW = decodeSolarPower(
        powers?.slice(0, 2) ?? (await this.read(REGISTERS.pvW.address, 2)),
      );
    } catch {
      result.selfPvW = null;
    }
    result.essW = decode32(powers?.slice(2) ?? (await this.read(REGISTERS.essW.address, 2)), true);
    result.capacityKWh = await this.readCapacity();
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
    for (const keys of [
      ['chargePowerLimitKW', 'dischargePowerLimitKW'],
      ['availableChargeKWh', 'availableDischargeKWh', 'nominalChargeKW', 'nominalDischargeKW'],
      ['chargeCutoffSoc', 'dischargeCutoffSoc', 'soh'],
    ]) {
      const start = OPTIONAL_BATTERY_REGISTERS[keys[0]].address;
      const last = OPTIONAL_BATTERY_REGISTERS[keys.at(-1)];
      let block;
      try {
        block = await this.readBlock(start, last.address + last.count - start);
      } catch (error) {
        for (const key of keys) errors[key] = String(error.message);
        continue;
      }
      for (const key of keys) {
        const def = OPTIONAL_BATTERY_REGISTERS[key];
        const offset = def.address - start;
        try {
          const words =
            block?.slice(offset, offset + def.count) ?? (await this.read(def.address, def.count));
          values[key] = (def.count === 1 ? words[0] : decode32(words, false)) / def.divisor;
        } catch (error) {
          errors[key] = String(error.message);
        }
      }
    }
    const validated = validateBatteryTelemetry(values);
    for (const key of Object.keys(values))
      if (!(key in validated)) errors[key] = 'Invalid optional battery value';
    return { values: validated, errors, readAt: new Date().toISOString() };
  }
  async energyCounters(profile, solarSource = 'self', flowMeters) {
    const startedAt = Date.now();
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
      if (flowMeters) {
        const raw = flowMeters[METERS[(address - 30228) / 4]];
        if (Number.isSafeInteger(raw) && raw >= 0) values[key] = String(raw);
        else errors[key] = 'invalid';
        continue;
      }
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
    const solarComponents =
      solarSource === 'combined' ? [values.solar, values.thirdPartySolar] : null;
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
    return {
      values,
      errors,
      durationMs: Date.now() - startedAt,
      ...(solarComponents ? { solarComponents } : {}),
    };
  }
  async flowMeterSnapshot() {
    if (Number(this.unitId) !== 247) throw Error('Flow meters require plant unit 247');
    if (this.flowBlockUnsupported) throw Error('Flow block unsupported');
    let words;
    try {
      words = await this.read(30228, 44, 1000);
    } catch (error) {
      if (error?.modbusCode === 2) this.flowBlockUnsupported = true;
      throw error;
    }
    if (words?.length !== 44) throw Error('Incomplete plant flow meters');
    return Object.fromEntries(
      METERS.map((key, i) => {
        try {
          return [key, Number(decodeEnergy(words.slice(i * 4, i * 4 + 4)))];
        } catch {
          return [key, null];
        }
      }),
    );
  }
  async householdPower() {
    if (Number(this.unitId) !== 247) throw Error('Household power requires plant unit 247');
    const words = await this.read(30282, 2, 1000);
    if (
      !Array.isArray(words) ||
      words.length !== 2 ||
      !words.every((w) => Number.isInteger(w) && w >= 0 && w <= 65535)
    )
      return null;
    const watts = decode32(words, true);
    return watts >= 0 && watts <= 350000 ? watts : null;
  }
  async householdEnergyCounter() {
    if (Number(this.unitId) !== 247) throw Error('Household energy requires plant unit 247');
    // V2.9 table 5-1: common load energy excludes EVAC and EVDC charging.
    return decodeEnergy(await this.read(30228, 4, 1000));
  }
  async gridPhaseBlock(address, count = 12) {
    // Each block contains two three-phase quantities, signed high word first.
    try {
      const words = await this.read(address, count, 1000);
      if (words.length !== count) return [];
      return Array.from({ length: count / 2 }, (_, phase) => {
        const i = phase * 2;
        const pair = words.slice(i, i + 2);
        if (!pair.every((w) => Number.isInteger(w) && w >= 0 && w <= 65535)) return null;
        const value = decode32(pair, true);
        return value === -2147483648 || value === 2147483647 ? null : value;
      });
    } catch {
      return [];
    }
  }
  async readGatewayStatus() {
    const words = await this.read(30004, 6, 1000).catch(() => null);
    if (
      !Array.isArray(words) ||
      words.length !== 6 ||
      !words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    )
      return null;
    return {
      sensorOnline: words[0] === 1,
      gridW: decode32(words.slice(1, 3), true),
      gridMode: words[5],
    };
  }
  async gatewayPhases(sharedGatewayStatus) {
    if (Number(this.unitId) !== 247) throw Error('Gateway requires plant unit 247');
    const status = await (sharedGatewayStatus ?? this.readGatewayStatus());
    const alarms = await this.read(30027, 1, 1000).catch(() => []);
    // Plant merged PCS Alarm1, bits 9–14, identifies reported grid alarms.
    const raw = alarms[0];
    const event = {
      gridMode: [0, 1, 2].includes(status?.gridMode) ? status.gridMode : null,
      gridAlarms:
        alarms.length === 1 && Number.isInteger(raw) && raw >= 0 && raw < 65535
          ? (raw >>> 9) & 63
          : null,
    };
    if (!status?.sensorOnline) return event;
    const electrical = await this.gridPhaseBlock(30286);
    // Older firmware can reject the voltage/current block but still expose current.
    const currents = electrical.length ? electrical.slice(3) : await this.gridPhaseBlock(30292, 6);
    const power = await this.gridPhaseBlock(30052);
    const scale = (words, offset, divisor, magnitude = false) =>
      [0, 1, 2].map((phase) => {
        const raw = words[offset + phase];
        if (!Number.isFinite(raw)) return null;
        return (magnitude ? Math.abs(raw) : raw) / divisor;
      });
    const amps = currents.every((v) => v === -1)
      ? [null, null, null]
      : scale(currents, 0, 100, true).map((a) => (a !== null && a <= 10000 ? a : null));
    // The November V2.8 map and V2.9 assign different meanings to 30286.
    // Require a coherent low-voltage triplet before accepting this register layout.
    const candidates = scale(electrical, 0, 100);
    const volts = candidates.every((v) => v !== null && v >= 0 && v <= 500)
      ? candidates
      : [null, null, null];
    return {
      ...event,
      amps,
      volts,
      activeKW: scale(power, 0, 1000),
      reactiveKvar: scale(power, 3, 1000),
    };
  }
  async phaseCurrents(source) {
    if (source !== 'grid') throw Error('Unsupported phase current source');
    const words = await this.read(6, 6, 1000);
    if (
      !Array.isArray(words) ||
      words.length !== 6 ||
      ![...words].every((word) => Number.isInteger(word) && word >= 0 && word <= 65535)
    )
      throw Error('Invalid phase current registers');
    const amps = [0, 2, 4].map((i) => {
      const pair = Buffer.alloc(4);
      pair.writeUInt16BE(words[i], 0);
      pair.writeUInt16BE(words[i + 1], 2);
      return pair.readFloatBE(0);
    });
    if (!validAmps(amps)) throw Error('Invalid phase current registers');
    return amps;
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
