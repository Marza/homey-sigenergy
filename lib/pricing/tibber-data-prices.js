'use strict';
const QUARTER = 900000;
const ORIGIN = 'https://data-api.tibber.com';
class DataError extends Error {
  constructor(code, retryMs = 3600000) {
    super(code);
    this.code = code;
    this.retryMs = retryMs;
  }
}
function decimal(value) {
  if (typeof value === 'string' && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new DataError('invalid-price-data');
  if (
    !['number', 'string'].includes(typeof value) ||
    !Number.isFinite(Number(value)) ||
    Math.abs(Number(value)) > 1000000
  )
    throw new DataError('invalid-price-data');
  return Number(value);
}
function instant(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    throw new DataError('invalid-price-data');
  const n = Date.parse(value);
  if (
    !Number.isSafeInteger(n) ||
    n < 0 ||
    n % QUARTER !== 0 ||
    new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    throw new DataError('invalid-price-data');
  return n;
}
function endpoint(homeId) {
  if (typeof homeId !== 'string' || !/^[-a-zA-Z0-9_]{1,200}$/.test(homeId))
    throw new DataError('invalid-home');
  return `${ORIGIN}/v1/homes/${encodeURIComponent(homeId)}/prices`;
}
function pageUrl(value, homeId) {
  let u;
  try {
    u = new URL(value, ORIGIN);
  } catch {
    throw new DataError('invalid-pagination');
  }
  const expected = new URL(endpoint(homeId));
  if (
    u.origin !== ORIGIN ||
    u.pathname !== expected.pathname ||
    u.username ||
    u.password ||
    u.hash ||
    [...u.searchParams.keys()].some((k) => !['cursor', 'since', 'until'].includes(k))
  )
    throw new DataError('invalid-pagination');
  return u.href;
}
function normalizePage(page) {
  if (page?.currency !== 'SEK' || !Array.isArray(page.items) || page.items.length > 192)
    throw new DataError('invalid-price-data');
  const start = instant(page.query?.effectiveStart),
    end = instant(page.query?.effectiveEnd);
  if (end < start) throw new DataError('invalid-price-data');
  const detail = (v) => {
    const price = decimal(v?.price),
      vat = decimal(v?.vatPercent);
    if (vat < 0 || vat > 100) throw new DataError('invalid-price-data');
    return {
      price,
      vat,
      ...(v.thirdPartyPrice !== undefined ? { thirdParty: decimal(v.thirdPartyPrice) } : {}),
    };
  };
  const rows = page.items.map((item) => {
    const t = instant(item?.time);
    if (t < start || t + QUARTER > end) throw new DataError('invalid-price-data');
    return {
      t,
      consumption: detail(item.consumption),
      ...(item.production ? { production: detail(item.production) } : {}),
    };
  });
  return { start, end, rows };
}
async function fetchPriceWindow(request, homeId, from, now = Date.now()) {
  let url = `${endpoint(homeId)}?since=${encodeURIComponent(new Date(from).toISOString())}`;
  const seen = new Set(),
    byTime = new Map();
  let done = false;
  for (let i = 0; i < 20; i++) {
    url = pageUrl(url, homeId);
    if (seen.has(url)) throw new DataError('invalid-pagination');
    seen.add(url);
    const page = await request(url),
      data = normalizePage(page);
    for (const row of data.rows) {
      if (row.t < from || row.t > now + 3 * 86400000) throw new DataError('invalid-price-data');
      const previous = byTime.get(row.t);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row))
        throw new DataError('conflicting-prices');
      byTime.set(row.t, row);
    }
    if (!data.rows.length && data.start >= Math.floor(now / QUARTER) * QUARTER) {
      done = true;
      break;
    }
    if (!page.next) {
      done = true;
      break;
    }
    url = pageUrl(page.next, homeId);
  }
  if (!done) throw new DataError('pagination-limit');
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}
module.exports = {
  DataError,
  QUARTER,
  ORIGIN,
  decimal,
  endpoint,
  pageUrl,
  normalizePage,
  fetchPriceWindow,
};
