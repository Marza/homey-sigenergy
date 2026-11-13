/* Shared price intervals and coverage rules. Browser copies are synchronized by scripts/sync-source-status.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PriceCoverage = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const RESOLUTIONS = Object.freeze({ HOURLY: 3600000, QUARTER_HOURLY: 900000 });
  const dateFormatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const hourFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const ms = (value) =>
    typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  const iso = (value) => new Date(value).toISOString();
  function dayBounds(date) {
    const midnight = Date.parse(date + 'T00:00:00Z');
    const next = midnight + 86400000;
    return {
      start: midnight - Number(hourFormatter.format(midnight)) * 3600000,
      end: next - Number(hourFormatter.format(next)) * 3600000,
    };
  }
  function calendar(now = new Date()) {
    const today = dateFormatter.format(now);
    const tomorrow = iso(Date.parse(today + 'T00:00:00Z') + 86400000).slice(0, 10);
    return {
      today: { date: today, ...dayBounds(today) },
      tomorrow: { date: tomorrow, ...dayBounds(tomorrow) },
    };
  }
  function coverageFor(prices, from, to) {
    const start = ms(from),
      end = ms(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw new Error('Invalid price coverage window');
    let cursor = start,
      coveredMs = 0;
    const gaps = [];
    for (const row of [...prices].sort((a, b) => ms(a.start) - ms(b.start))) {
      const left = Math.max(start, ms(row.start)),
        right = Math.min(end, ms(row.end));
      if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left || right <= cursor)
        continue;
      if (left > cursor) gaps.push({ start: iso(cursor), end: iso(left) });
      coveredMs += right - Math.max(left, cursor);
      cursor = right;
    }
    if (cursor < end) gaps.push({ start: iso(cursor), end: iso(end) });
    return {
      start: iso(start),
      end: iso(end),
      expectedMs: end - start,
      coveredMs,
      complete: coveredMs === end - start,
      state: coveredMs === end - start ? 'complete' : coveredMs ? 'partial' : 'missing',
      gaps,
    };
  }
  function inspectCache(cache) {
    if (!cache) return { prices: [], reason: 'missing' };
    if (cache.schema !== 2 || !RESOLUTIONS[cache.resolution])
      return { prices: [], reason: 'unverified-intervals' };
    if (cache.currency !== 'SEK' || !Array.isArray(cache.prices))
      return { prices: [], reason: 'invalid-cache' };
    const prices = [...cache.prices].sort((a, b) => ms(a?.start) - ms(b?.start));
    let end = -Infinity;
    for (const row of prices) {
      const left = ms(row?.start),
        right = ms(row?.end),
        duration = RESOLUTIONS[cache.resolution];
      if (
        !Number.isFinite(left) ||
        !Number.isFinite(right) ||
        left % duration !== 0 ||
        right - left !== duration ||
        left < end ||
        !Number.isFinite(row?.price)
      )
        return { prices: [], reason: 'invalid-cache' };
      end = right;
    }
    return { prices, reason: null };
  }
  function refreshPolicy({ cache, lastAttemptAt, now = new Date() }) {
    const time = now.getTime(),
      days = calendar(now);
    const fetched = ms(cache?.fetchedAt);
    const prices = Number.isFinite(fetched) && fetched <= time ? inspectCache(cache).prices : [];
    const tomorrowComplete = coverageFor(prices, days.tomorrow.start, days.tomorrow.end).complete;
    const hasCurrent = prices.some((p) => ms(p.start) <= time && ms(p.end) > time);
    const hour = Number(hourFormatter.format(now));
    const intervalMinutes = !hasCurrent || (hour >= 13 && !tomorrowComplete) ? 15 : 60;
    const last = ms(lastAttemptAt);
    const next = !Number.isFinite(last) || last > time ? time : last + intervalMinutes * 60000;
    return {
      intervalMinutes,
      nextAttemptAt: iso(Math.max(time, next)),
      eligible: time >= next,
      checkIntervalMinutes: 5,
      tomorrowComplete,
    };
  }
  function priceStatus(values, now = Date.now()) {
    const configured = typeof values.tibberToken === 'string' && !!values.tibberToken.trim();
    const cache = values.priceCache,
      inspected = inspectCache(cache),
      time = new Date(now),
      days = calendar(time);
    const source = values.sourceConfig?.tibber;
    const fetched = ms(cache?.fetchedAt);
    const changed =
      !!cache &&
      ((String(values.tibberHomeId || '').trim() || null) !== cache.selectedHomeId ||
        (source?.revision && cache.configRevision !== source.revision));
    const validTime = Number.isFinite(fetched) && fetched <= now;
    const prices = configured && !changed && validTime ? inspected.prices : [];
    const today = coverageFor(prices, now, days.today.end),
      tomorrow = coverageFor(prices, days.tomorrow.start, days.tomorrow.end);
    const horizon = coverageFor(prices, now, days.tomorrow.end);
    const future = prices.filter((p) => ms(p.end) > now);
    const reason = !configured
      ? 'disabled'
      : changed
        ? 'configuration-changed'
        : cache && !validTime
          ? 'invalid-time'
          : inspected.reason;
    let status = !configured
      ? 'disabled'
      : values.priceError
        ? 'error'
        : reason
          ? 'no-data'
          : future.length
            ? horizon.complete
              ? 'ok'
              : 'partial'
            : 'stale';
    if (configured && cache && !validTime && !values.priceError) status = 'stale';
    return {
      configured,
      enabled: configured,
      status,
      usable: configured && future.length > 0,
      ageSeconds: validTime ? Math.floor((now - fetched) / 1000) : null,
      error: configured ? values.priceError || null : null,
      fieldErrors: {},
      reason: reason || (!future.length ? 'expired-prices' : null),
      coverage: { today, tomorrow, horizon },
      currency: cache?.currency || null,
      fetchedAt: cache?.fetchedAt || null,
      lastAttemptAt: values.priceLastAttemptAt || null,
      availableIntervals: future.length,
      availableFrom: future[0]?.start || null,
      availableTo: future.at(-1)?.end || null,
      refresh: refreshPolicy({
        cache: changed ? null : cache,
        lastAttemptAt: values.priceLastAttemptAt,
        now: time,
      }),
    };
  }
  function usablePrices(values, now = Date.now()) {
    return priceStatus(values, now).usable
      ? inspectCache(values.priceCache).prices.filter((p) => ms(p.end) > now)
      : [];
  }
  return {
    RESOLUTIONS,
    calendar,
    coverageFor,
    inspectCache,
    refreshPolicy,
    priceStatus,
    usablePrices,
  };
});
