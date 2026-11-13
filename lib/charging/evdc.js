'use strict';
// Experimental read-only probes: verify register width, scaling and unit ID against
// the exact EVDC firmware/protocol before enabling. No writes are implemented.
const EVDC_REGISTERS = Object.freeze({ powerW: 31502, soc: 31504 });
function validateEvdc({ powerW, soc }) {
  if (!Number.isFinite(soc) || soc < 0 || soc > 100) throw new Error('Invalid EVDC SoC');
  if (!Number.isFinite(powerW) || powerW < 0 || powerW > 30000)
    throw new Error('Invalid EVDC power');
  return { powerW, soc };
}
async function readEvdc(
  reader,
  { powerAddress = 31502, socAddress = 31504, powerScale = 1, socScale = 1 } = {},
) {
  if (!(powerScale > 0) || !(socScale > 0)) throw new Error('Invalid EVDC scaling');
  // Register layouts are not verified; do not silently assume a 32-bit value.
  const powerWords = await reader.read(powerAddress, 2);
  const socWords = await reader.read(socAddress, 1);
  const rawPower = powerWords[0] * 65536 + powerWords[1];
  return validateEvdc({ powerW: rawPower / powerScale, soc: socWords[0] / socScale });
}
module.exports = { EVDC_REGISTERS, readEvdc, validateEvdc };
