'use strict';
const Homey = require('homey');
module.exports = require('../../lib/energy/reporting').createDevice(Homey, 'solar');
