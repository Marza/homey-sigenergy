'use strict';

// Illustrative starting curves ONLY. Calibrate with site measurements before economic dispatch.
const DEFAULT_PROFILE = Object.freeze({
  ev: { minKW: 2, maxKW: 15, points: [[2, 0.80], [4, 0.88], [7, 0.92], [11, 0.94], [15, 0.94]] },
  home: { minKW: 0.5, maxKW: 10, points: [[0.5, 0.85], [2, 0.92], [5, 0.95], [10, 0.94]] },
  stepKW: 0.5,
});

function efficiencyAt(points, kw) {
  if (!Number.isFinite(kw) || kw < 0) throw new Error('Invalid power');
  if (kw === 0) return 0;
  if (!Array.isArray(points) || points.length < 2) throw new Error('Invalid efficiency curve');
  for (let i = 0; i < points.length; i++) {
    const [p, eta] = points[i];
    if (!(p > 0 && eta > 0 && eta <= 1) || (i > 0 && p <= points[i - 1][0])) {
      throw new Error('Invalid efficiency curve');
    }
  }
  if (kw <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (kw <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      return y0 + (y1 - y0) * (kw - x0) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/**
 * Dry-run allocation of available PV surplus. Marginal values are currency per kWh STORED.
 * The EV's value should reflect future required grid charging before its deadlines;
 * home value should reflect avoided purchases or later sales, including discharge losses.
 * Export price is currency per kWh exported. No device commands are issued.
 */
function allocateSolar({ surplusKW, evConnected, evSoc, evMaxSoc = 80, homeSoc,
  evValuePerKWh, homeValuePerKWh, exportPricePerKWh,
  gridHeadroomKW = Infinity, profile = DEFAULT_PROFILE }) {
  const nums = [surplusKW, evSoc, evMaxSoc, homeSoc, evValuePerKWh,
    homeValuePerKWh, exportPricePerKWh];
  if (nums.some(x => !Number.isFinite(x)) || surplusKW < 0 ||
    [evSoc, evMaxSoc, homeSoc].some(x => x < 0 || x > 100) ||
    !(gridHeadroomKW >= 0) || !(profile.stepKW > 0)) throw new Error('Invalid dispatch inputs');
  const available = Math.min(surplusKW, gridHeadroomKW);
  const step = profile.stepKW;
  let best = null;
  // Discrete exhaustive search; for 25kW and 0.5kW step this is inexpensive.
  const maxEvSteps = evConnected && evSoc < evMaxSoc ?
    Math.floor(Math.min(available, profile.ev.maxKW) / step) : 0;
  for (let ei = 0; ei <= maxEvSteps; ei++) {
    const evKW = ei * step;
    if (evKW > 0 && evKW < profile.ev.minKW) continue;
    const maxHomeSteps = homeSoc < 100 ?
      Math.floor(Math.min(available - evKW, profile.home.maxKW) / step) : 0;
    for (let hi = 0; hi <= maxHomeSteps; hi++) {
      const homeKW = hi * step;
      if (homeKW > 0 && homeKW < profile.home.minKW) continue;
      const exportKW = Math.max(0, surplusKW - evKW - homeKW);
      const evStoredKW = evKW * efficiencyAt(profile.ev.points, evKW);
      const homeStoredKW = homeKW * efficiencyAt(profile.home.points, homeKW);
      const valuePerHour = evStoredKW * evValuePerKWh +
        homeStoredKW * homeValuePerKWh + exportKW * exportPricePerKWh;
      if (!best || valuePerHour > best.valuePerHour + 1e-9) {
        best = { evKW, homeKW, exportKW, evStoredKW, homeStoredKW, valuePerHour };
      }
    }
  }
  return { ...best, mode: 'simulation', efficiencyProfile: 'illustrative-not-calibrated' };
}

module.exports = { DEFAULT_PROFILE, efficiencyAt, allocateSolar };
