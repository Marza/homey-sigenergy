'use strict';
// Compatibility entry point; both models use the shared, bounded replay engine.
const { replayWithRecharge, compareScenarios } = require('./simulator');
module.exports = { replayWithRecharge, compareScenarios };
