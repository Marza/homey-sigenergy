'use strict';
const { RESOLUTIONS, calendar } = require('./coverage');
const ENDPOINT = 'https://api.tibber.com/v1-beta/gql';
function normalizePrices(home, now = new Date(), { resolution = 'QUARTER_HOURLY' } = {}) {
  const duration = RESOLUTIONS[resolution];
  if (!duration) throw new Error('Unsupported Tibber price resolution');
  const info = home?.currentSubscription?.priceInfo;
  if (!info) throw new Error('Tibber subscription priceInfo unavailable');
  const byStart = new Map(),
    days = calendar(now);
  for (const key of ['today', 'tomorrow']) {
    if (!Array.isArray(info[key])) throw new Error('Invalid Tibber price list');
    for (const row of info[key]) {
      if (
        typeof row?.startsAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          row.startsAt,
        )
      )
        throw new Error('Invalid Tibber price timestamp');
      const start = Date.parse(row.startsAt);
      if (
        !Number.isFinite(start) ||
        new Date(Date.parse(row.startsAt.slice(0, 10) + 'T00:00:00Z'))
          .toISOString()
          .slice(0, 10) !== row.startsAt.slice(0, 10) ||
        start % duration !== 0 ||
        start < days[key].start ||
        start + duration > days[key].end ||
        !Number.isFinite(row.total)
      )
        throw new Error('Invalid or ambiguous Tibber price interval');
      if (row.currency !== 'SEK') throw new Error('Unsupported Tibber currency; expected SEK');
      const previous = byStart.get(start);
      if (previous && previous.price !== row.total)
        throw new Error('Conflicting duplicate Tibber price');
      byStart.set(start, {
        start: new Date(start).toISOString(),
        end: new Date(start + duration).toISOString(),
        price: row.total,
      });
    }
  }
  return [...byStart.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
async function fetchTibberPrices({
  token,
  homeId,
  fetchImpl = fetch,
  now = new Date(),
  resolution = 'QUARTER_HOURLY',
}) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Tibber token missing');
  token = token.trim();
  if (homeId !== undefined && typeof homeId !== 'string') throw new Error('Invalid Tibber home ID');
  homeId = homeId?.trim() || undefined;
  if (!RESOLUTIONS[resolution]) throw new Error('Unsupported Tibber price resolution');
  const query = `query { viewer { homes { id currentSubscription { priceInfo(resolution: ${resolution}) { today { startsAt total currency } tomorrow { startsAt total currency } } } } } }`;
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'sigenergy-homey-local',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(12000),
    });
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Network causes may include request credentials.
    throw new Error(
      error.name === 'TimeoutError' ? 'Tibber request timed out' : 'Tibber network request failed',
    );
  }
  if (!response.ok) throw new Error(`Tibber HTTP ${response.status}`);
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error('Tibber invalid JSON response');
  }
  // Do not copy arbitrary upstream text into diagnostics where it could echo credentials.
  if (json.errors?.length) throw new Error('Tibber GraphQL request failed');
  const homes = json.data?.viewer?.homes;
  if (!Array.isArray(homes)) throw new Error('Invalid Tibber homes response');
  const matches = homeId ? homes.filter((h) => h?.id === homeId) : homes;
  const home = matches.length === 1 ? matches[0] : null;
  if (!home || typeof home.id !== 'string' || !home.id)
    throw new Error('Select a valid Tibber home ID (required for multiple homes)');
  const prices = normalizePrices(home, now, { resolution });
  if (!prices.some((p) => Date.parse(p.end) > now.getTime()))
    throw new Error('No usable upcoming Tibber prices');
  return {
    schema: 2,
    selectedHomeId: homeId || null,
    duplicateRows:
      home.currentSubscription.priceInfo.today.length +
      home.currentSubscription.priceInfo.tomorrow.length -
      prices.length,
    homeId: home.id,
    fetchedAt: now.toISOString(),
    resolution,
    currency: 'SEK',
    prices,
  };
}
module.exports = { fetchTibberPrices, normalizePrices };
