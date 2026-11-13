'use strict';
const { refreshPolicy } = require('./coverage');
function hasTomorrowPrices(cache, now = new Date()) {
  return refreshPolicy({ cache, now }).tomorrowComplete;
}
function shouldRefreshPrices(options) {
  return refreshPolicy(options).eligible;
}
module.exports = { hasTomorrowPrices, shouldRefreshPrices };
