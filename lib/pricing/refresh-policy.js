'use strict';

function stockholmDateKey(date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function stockholmHour(date) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', hour: '2-digit', hourCycle: 'h23' }).format(date));
}
function hasTomorrowPrices(cache, now = new Date()) {
  const tomorrow = new Date(now.getTime() + 36 * 3600000);
  const tomorrowKey = stockholmDateKey(tomorrow);
  // The date 36h ahead may be the day after tomorrow late in the day: derive next local day by checking UTC dates around now.
  const todayKey = stockholmDateKey(now);
  let nextDayKey = null;
  for (let h = 1; h <= 30; h++) {
    const key = stockholmDateKey(new Date(now.getTime() + h * 3600000));
    if (key !== todayKey) { nextDayKey = key; break; }
  }
  return Boolean(cache?.prices?.some(p => stockholmDateKey(new Date(p.start)) === (nextDayKey || tomorrowKey)));
}
function shouldRefreshPrices({ now = new Date(), cache, lastAttemptAt }) {
  const elapsed = lastAttemptAt ? now.getTime() - Date.parse(lastAttemptAt) : Infinity;
  if (elapsed < 0) return false;
  const tomorrowMissing = !hasTomorrowPrices(cache, now);
  const interval = stockholmHour(now) >= 13 && tomorrowMissing ? 15 * 60000 : 60 * 60000;
  return elapsed >= interval;
}
module.exports = { stockholmDateKey, stockholmHour, hasTomorrowPrices, shouldRefreshPrices };
