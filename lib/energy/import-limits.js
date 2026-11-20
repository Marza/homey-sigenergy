'use strict';

const KEY = 'householdImportLimits';

function readImportLimits(value) {
  if (value === null || value === undefined)
    return { configuredKW: null, fuseA: null, nominalFuseKW: null, limitKW: null };
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['importLimitKW', 'mainFuseA'].includes(key))
  )
    throw Error('invalid-household-import-limits');
  const configuredKW = value.importLimitKW ?? null;
  const fuseA = value.mainFuseA ?? null;
  if (
    (configuredKW !== null &&
      (!Number.isFinite(configuredKW) || configuredKW <= 0 || configuredKW > 1000)) ||
    (fuseA !== null && (!Number.isInteger(fuseA) || fuseA < 1 || fuseA > 1000))
  )
    throw Error('invalid-household-import-limits');
  // Balanced 400 V three-phase comparison at power factor 1. Real line
  // currents, voltage and instantaneous power cannot be recovered from kWh.
  const nominalFuseKW = fuseA === null ? null : (Math.sqrt(3) * 400 * fuseA) / 1000;
  const limitKW =
    configuredKW === null
      ? nominalFuseKW
      : nominalFuseKW === null
        ? configuredKW
        : Math.min(configuredKW, nominalFuseKW);
  return { configuredKW, fuseA, nominalFuseKW, limitKW };
}
module.exports = { KEY, readImportLimits };
