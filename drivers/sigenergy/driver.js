'use strict';
const Homey = require('homey');
module.exports = class SigenergyDriver extends Homey.Driver {
  async onPairListDevices() {
    return [
      {
        name: 'Sigenergy plant (configure IP in advanced settings)',
        data: { id: 'sigenergy-plant-247' },
      },
    ];
  }
};
