'use strict';
const { getPowerHistory } = require('../../lib/energy/dashboard-history');

module.exports = {
  getHistory: ({ homey, params }, now) => getPowerHistory(homey, params, now),
};
