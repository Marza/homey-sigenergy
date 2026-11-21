'use strict';
const { getEnergyFlow } = require('../../lib/energy/dashboard-history');

module.exports = {
  getHistory: ({ homey, params }, now) => getEnergyFlow(homey, params, now),
};
