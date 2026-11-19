'use strict';
const { decode32 } = require('../modbus');
const MAX_U32 = 0xffffffff;

function validateUnitId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const id = Number(value);
  return Number.isInteger(id) && id >= 1 && id <= 246 ? id : null;
}

function energyKWh(words) {
  const value = decode32(words, false);
  return value === MAX_U32 ? null : value / 100;
}

// Sigenergy V2.9, table 5-3. These are input registers on the inverter hosting
// the DC charger. Power is signed (raw watts); vehicle SoC is in tenths of a percent.
const GROUPS = [
  [
    31502,
    2,
    {
      powerW: (words) => {
        const watts = decode32(words, true);
        return Math.abs(watts) <= 350000 ? watts : null;
      },
    },
  ],
  [
    31504,
    3,
    {
      soc: ([soc]) => (soc <= 1000 ? soc / 10 : null),
      sessionKWh: (words) => energyKWh(words.slice(1)),
    },
  ],
  [
    31513,
    10,
    {
      state: ([state]) => (state <= 10 ? state : null),
      totalChargedKWh: (words) => energyKWh(words.slice(6, 8)),
      totalDischargedKWh: (words) => energyKWh(words.slice(8, 10)),
    },
  ],
];

async function readEvdc(reader) {
  const values = {},
    errors = {};
  let powerReadAt, powerFailure;
  for (const [address, count, fields] of GROUPS) {
    let words;
    try {
      words = await reader.read(address, count, 1000);
    } catch (error) {
      if (address === 31502) powerFailure = error;
    }
    if (address === 31502) powerReadAt = Date.now();
    const valid =
      Array.isArray(words) &&
      words.length === count &&
      words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff);
    for (const [key, decode] of Object.entries(fields)) {
      const value = valid ? decode(words) : null;
      if (value !== null) values[key] = value;
      else
        errors[key] = valid
          ? 'Ogiltigt eller otillgängligt värde'
          : 'Modbus-registret kunde inte läsas';
    }
  }
  return { values, errors, powerReadAt, powerFailure };
}

module.exports = { readEvdc, validateUnitId };
