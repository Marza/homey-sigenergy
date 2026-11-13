'use strict';
// Manifest routes are authenticated by Homey; none are public.
module.exports = {
  async previewCharging({ homey, body }) {
    return homey.app.getChargingPreview(body);
  },
  async exportHistory({ homey }) {
    return homey.app.history.export();
  },
  async previewHistoryImport({ homey, body }) {
    return homey.app.history.previewImport(body);
  },
  async importHistory({ homey, body }) {
    return homey.app.history.import(body);
  },
};
