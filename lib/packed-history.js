'use strict';
const { gzipSync, gunzipSync } = require('node:zlib');
const { MAX_STATE_BYTES } = require('./history-format');

// Homey's settings manager serializes all settings on each set(). Keeping large
// measurement trees opaque avoids walking every old sample on each live poll.
function pack(value) {
  const json = Buffer.from(JSON.stringify(value));
  if (json.length > MAX_STATE_BYTES) throw Error('History exceeds storage budget');
  return {
    encoding: 'gzip-json-v1',
    bytes: json.length,
    data: gzipSync(json, { level: 1 }).toString('base64'),
  };
}
function unpack(value) {
  if (!value || !Object.hasOwn(value, 'encoding')) return value;
  if (
    value.encoding !== 'gzip-json-v1' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    value.bytes > MAX_STATE_BYTES ||
    typeof value.data !== 'string'
  )
    throw Error('Invalid packed history');
  const raw = gunzipSync(Buffer.from(value.data, 'base64'), { maxOutputLength: value.bytes });
  if (raw.length !== value.bytes) throw Error('Incomplete packed history');
  return JSON.parse(raw.toString('utf8'));
}
function historySettings(settings) {
  return {
    get(key) {
      const value = settings.get(key);
      return key === 'historyState' ? unpack(value) : value;
    },
    set(key, value) {
      if (key !== 'historyState') throw Error('Unexpected history key');
      settings.set(key, { ...pack(value), revision: value.revision, updatedAt: value.updatedAt });
    },
  };
}
module.exports = { pack, unpack, historySettings };
