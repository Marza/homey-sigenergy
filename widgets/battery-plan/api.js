'use strict';
const { getBatteryPlan } = require('../../lib/energy/battery-plan-report');
module.exports = { getPlan: ({ homey }) => getBatteryPlan(homey) };
