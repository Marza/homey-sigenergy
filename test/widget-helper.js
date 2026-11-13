'use strict';
const { getOverview } = require('../widgets/energy-overview/api');
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
module.exports = { attachWidgetApi };
