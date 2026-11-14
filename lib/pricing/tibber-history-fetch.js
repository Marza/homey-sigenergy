'use strict';
const HOUR = 3600000,
  ENDPOINT = 'https://api.tibber.com/v1-beta/gql';
class PriceError extends Error {
  constructor(code, retryMs = HOUR) {
    super(code);
    this.code = code;
    this.retryMs = retryMs;
  }
}
function instant(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    throw new PriceError('invalid-history');
  const t = Date.parse(value);
  if (
    !Number.isSafeInteger(t) ||
    t < 0 ||
    t % HOUR ||
    new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    throw new PriceError('invalid-history');
  return t;
}
function detail(row, direction) {
  const price = row.unitPrice,
    vat = row.unitPriceVAT;
  if (price === null || price === undefined) return null;
  if (row.currency !== 'SEK') throw new PriceError('unsupported-currency');
  if (
    !Number.isFinite(price) ||
    Math.abs(price) > 1e6 ||
    (vat !== null && vat !== undefined && !Number.isFinite(vat))
  )
    throw new PriceError('invalid-history');
  const energy = row[direction === 'consumption' ? 'consumption' : 'production'];
  const unit = row[direction === 'consumption' ? 'consumptionUnit' : 'productionUnit'];
  const amount = row[direction === 'consumption' ? 'cost' : 'profit'];
  if (
    energy !== null &&
    energy !== undefined &&
    (!Number.isFinite(energy) || energy < 0 || energy > 1e6 || unit !== 'kWh')
  )
    throw new PriceError('invalid-history');
  if (amount !== null && amount !== undefined && !Number.isFinite(amount))
    throw new PriceError('invalid-history');
  // Check a supplied amount; never infer prices by division or add VAT again.
  if (
    Number.isFinite(energy) &&
    Number.isFinite(amount) &&
    Math.abs(energy * price - amount) > Math.max(0.02, Math.abs(amount) * 1e-5)
  )
    throw new PriceError('inconsistent-price-amount');
  return {
    price,
    ...(Number.isFinite(vat) ? { vatAmount: vat } : {}),
    ...(Number.isFinite(energy) ? { kWh: energy } : {}),
    ...(Number.isFinite(amount) ? { amount } : {}),
  };
}
function normalizeHours(home, id, from, to) {
  if (home?.id !== id) throw new PriceError('invalid-home');
  const byTime = new Map();
  for (const direction of ['consumption', 'production']) {
    const connection = home[direction];
    if ((connection === null || connection === undefined) && direction === 'production') continue;
    const nodes = connection?.nodes;
    if (!Array.isArray(nodes) || nodes.length > (to - from) / HOUR)
      throw new PriceError('invalid-history');
    const seen = new Map();
    for (const row of nodes) {
      const t = instant(row?.from),
        end = instant(row?.to);
      if (t < from || end > to || end - t !== HOUR) throw new PriceError('invalid-history');
      const d = detail(row, direction);
      if (seen.has(t) && JSON.stringify(seen.get(t)) !== JSON.stringify(d))
        throw new PriceError('conflicting-history');
      seen.set(t, d);
      if (!byTime.has(t)) byTime.set(t, { t });
      if (d) byTime.get(t)[direction] = d;
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}
async function fetchHistoryPrices({ token, homeId, from, to, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !token.trim()) throw new PriceError('not-configured');
  if (typeof homeId !== 'string' || !/^[-a-zA-Z0-9_]{1,200}$/.test(homeId))
    throw new PriceError('select-home');
  if (
    ![from, to].every(Number.isSafeInteger) ||
    from < 0 ||
    from % HOUR ||
    to % HOUR ||
    to <= from ||
    to - from > 32 * 24 * HOUR
  )
    throw new PriceError('invalid-window');
  async function request(query, variables) {
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new PriceError('network-error');
    }
    if (!response.ok) {
      const retry = Number(response.headers?.get('retry-after'));
      throw new PriceError(
        response.status === 401
          ? 'authorization-required'
          : response.status === 429
            ? 'rate-limited'
            : 'upstream-unavailable',
        response.status === 429 && Number.isFinite(retry) && retry > 0
          ? Math.min(86400000, Math.max(60000, retry * 1000))
          : HOUR,
      );
    }
    let json;
    try {
      const body = await response.text();
      if (body.length > 2 * 1024 * 1024) throw Error();
      json = JSON.parse(body);
    } catch {
      throw new PriceError('invalid-response');
    }
    if (json?.errors?.length || !json?.data) throw new PriceError('graphql-error');
    return json.data;
  }
  const data = await request('query { viewer { homes { id } } }');
  if (!Array.isArray(data.viewer?.homes) || !data.viewer.homes.some((h) => h?.id === homeId))
    throw new PriceError('invalid-home');
  const rows = [];
  // Finest documented Production/Consumption history resolution is HOURLY.
  for (let end = to; end > from;) {
    const start = Math.max(from, end - 744 * HOUR);
    const page = await request(
      'query($id: ID!, $last: Int!, $before: String!) { viewer { home(id: $id) { id consumption(resolution: HOURLY, last: $last, before: $before, filterEmptyNodes: false) { nodes { from to unitPrice unitPriceVAT consumption consumptionUnit cost currency } } production(resolution: HOURLY, last: $last, before: $before, filterEmptyNodes: false) { nodes { from to unitPrice unitPriceVAT production productionUnit profit currency } } } } }',
      {
        id: homeId,
        last: (end - start) / HOUR,
        before: Buffer.from(new Date(end).toISOString()).toString('base64'),
      },
    );
    rows.push(...normalizeHours(page.viewer?.home, homeId, start, end));
    end = start;
  }
  return rows.sort((a, b) => a.t - b.t);
}
module.exports = { HOUR, PriceError, normalizeHours, fetchHistoryPrices };
