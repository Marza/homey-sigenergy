'use strict';
const { getOverview } = require('../widgets/energy-overview/api');
const { HistoryStore } = require('../lib/history');
const { historySettings } = require('../lib/packed-history');
const { getHistoryOverview } = require('../api');

function attachHistoryApi(Homey) {
  Homey.api = (method, path, body, callback) => {
    if (method !== 'GET' || path !== '/history/overview') return;
    const settings = {
      get(key) {
        let value;
        Homey.get(key, (err, result) => {
          if (err) throw err;
          value = result;
        });
        return value;
      },
    };
    try {
      const history = new HistoryStore(historySettings(settings));
      callback(null, getHistoryOverview({ homey: { app: { history } } }));
    } catch (error) {
      callback(error);
    }
  };
}
// Existing rendering fixtures deliver settings synchronously. Exercise the real
// snapshot API with them while keeping their assertions deterministic.
function attachWidgetApi(Homey, Clock = Date) {
  Homey.api = () => {
    let value, error;
    try {
      value = getOverview(
        {
          homey: {
            settings: {
              get(key) {
                let result, failure;
                Homey.get(key, (e, v) => {
                  result = v;
                  failure = e;
                });
                if (failure) throw failure;
                return result;
              },
            },
          },
        },
        Clock === Date ? undefined : Clock.now(),
      );
    } catch (e) {
      error = e;
    }
    return {
      then(callback) {
        if (!error)
          try {
            callback(value);
          } catch (e) {
            error = e;
          }
        return {
          catch(onError) {
            if (error) onError(error);
          },
        };
      },
    };
  };
  return Homey;
}
module.exports = { attachWidgetApi, attachHistoryApi };
