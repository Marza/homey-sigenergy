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
const EVDC_GROUPS = [
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

// Sigenergy V2.9 table 5-5. The AC charger's cumulative meter and instantaneous
// power come from its own Modbus unit. A genuine idle reading is zero watts.
const EVAC_GROUPS = [
  [
    32000,
    5,
    {
      state: ([state]) => (state <= 7 ? state : null),
      totalConsumedKWh: (words) => energyKWh(words.slice(1, 3)),
      powerW: (words) => {
        const watts = decode32(words.slice(3), true);
        return watts >= 0 && watts <= 350000 ? watts : null;
      },
    },
  ],
];

async function readGroups(reader, groups) {
  const values = {},
    errors = {};
  let powerReadAt, powerFailure, socReadAt;
  for (const [address, count, fields] of groups) {
    const readsPower = Object.hasOwn(fields, 'powerW');
    let words;
    try {
      words = await reader.read(address, count, 1000);
    } catch (error) {
      if (readsPower) powerFailure = error;
    }
    if (Object.hasOwn(fields, 'soc')) socReadAt = Date.now();
    if (readsPower) powerReadAt = Date.now();
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
  return { values, errors, powerReadAt, powerFailure, socReadAt };
}

const EVDC_FAST_GROUPS = [EVDC_GROUPS[0], [31505, 2, { sessionKWh: energyKWh }], EVDC_GROUPS[2]];
const readEvdc = (reader, includeSoc = true) =>
  readGroups(reader, includeSoc ? EVDC_GROUPS : EVDC_FAST_GROUPS);
const readEvac = (reader) => readGroups(reader, EVAC_GROUPS);
module.exports = { readEvdc, readEvac, validateUnitId };
