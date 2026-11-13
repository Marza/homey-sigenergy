'use strict';
// Swedish public holidays (SFS 1989:253), plus Telge's two explicit low-load eves.
// Gregorian Easter: Meeus/Jones/Butcher computus. Dates are local calendar labels,
// represented in UTC here so the host timezone cannot shift a holiday.
function excludedDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  const ms = Date.UTC(year, month - 1, day);
  const weekday = new Date(ms).getUTCDay();
  if (weekday === 0) return true;
  if (
    ['01-01', '01-06', '05-01', '06-06', '12-24', '12-25', '12-26', '12-31'].includes(date.slice(5))
  )
    return true;
  if (
    weekday === 6 &&
    ((month === 6 && day >= 20 && day <= 26) ||
      (month === 10 && day === 31) ||
      (month === 11 && day <= 6))
  )
    return true;
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100;
  const d = Math.floor(b / 4),
    e = b % 4;
  const f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4),
    k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  const easter = Date.UTC(year, Math.floor(n / 31) - 1, (n % 31) + 1);
  return [-2, 1, 39].some((offset) => ms === easter + offset * 86400000);
}
module.exports = { excludedDate };
