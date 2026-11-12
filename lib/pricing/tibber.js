'use strict';
const ENDPOINT = 'https://api.tibber.com/v1-beta/gql';
const QUERY = `query { viewer { homes { id currentSubscription { priceInfo { today { startsAt total } tomorrow { startsAt total } } } } } }`;
function normalizePrices(home, now = new Date()) {
  const info = home?.currentSubscription?.priceInfo;
  if (!info) throw new Error('Tibber subscription priceInfo unavailable');
  const byStart = new Map();
  for (const row of [...(info.today || []), ...(info.tomorrow || [])]) {
    const ms = Date.parse(row.startsAt);
    if (!Number.isFinite(ms) || !Number.isFinite(row.total)) throw new Error('Invalid Tibber price');
    byStart.set(ms, { start: new Date(ms).toISOString(), price: row.total });
  }
  const sorted = [...byStart.entries()].sort((a,b) => a[0]-b[0]);
  // Tibber can provide hourly or quarter-hour prices. Infer interval from adjacent starts;
  // do not manufacture an interval when there is only one price.
  const slots = sorted.map(([ms, entry], i) => {
    const next = sorted[i+1]?.[0];
    const prev = sorted[i-1]?.[0];
    const duration = next ? next-ms : (prev ? ms-prev : 0);
    if (duration !== 900000 && duration !== 3600000) throw new Error('Unexpected or missing Tibber price interval');
    return { ...entry, end: new Date(ms+duration).toISOString() };
  });
  return slots.filter(p => Date.parse(p.end) > now.getTime());
}
async function fetchTibberPrices({ token, homeId, fetchImpl = fetch, now = new Date() }) {
  if (!token || typeof token !== 'string') throw new Error('Tibber token missing');
  const response = await fetchImpl(ENDPOINT, { method:'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type':'application/json', 'User-Agent':'sigenergy-homey-local/0.4' }, body: JSON.stringify({ query: QUERY }), signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Tibber HTTP ${response.status}`);
  const json = await response.json();
  if (json.errors?.length) throw new Error(`Tibber GraphQL: ${json.errors.map(e=>e.message).join('; ')}`);
  const homes = json.data?.viewer?.homes || [];
  const home = homeId ? homes.find(h=>h.id === homeId) : (homes.length === 1 ? homes[0] : null);
  if (!home) throw new Error('Select a valid Tibber home ID (required for multiple homes)');
  return { homeId: home.id, fetchedAt: now.toISOString(), prices: normalizePrices(home, now) };
}
module.exports = { fetchTibberPrices, normalizePrices };
