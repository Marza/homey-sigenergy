'use strict';
const shared = require('./source-status');
function diagnostics(settings, now = Date.now()) {
  return shared.diagnostics(Object.fromEntries(shared.SOURCE_KEYS.map(key => [key, settings.get(key)])), now);
}
module.exports = { ...shared, diagnostics };
