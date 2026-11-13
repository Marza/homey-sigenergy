'use strict';
const { calendar } = require('./coverage');
const { normalizeConsumption } = require('./consumption-history');
const HOUR = 3600000;
const ENDPOINT = 'https://api.tibber.com/v1-beta/gql';
function monthWindow(now = new Date()) {
  const date = calendar(now).today.date;
  const from = calendar(new Date(date.slice(0, 7) + '-01T12:00:00Z')).today.start;
  return { from, to: Math.floor(now.getTime() / HOUR) * HOUR };
}
function shouldSync({ now = new Date(), revision, sync, token }) {
  if (typeof token !== 'string' || !token.trim() || !revision) return false;
  if (sync?.configRevision !== revision) return true;
  const success = Date.parse(sync.lastSuccessAt);
  if (
    success <= now.getTime() &&
    calendar(new Date(success)).today.date === calendar(now).today.date
  )
    return false;
  const attempt = Date.parse(sync.lastAttemptAt);
  return !Number.isFinite(attempt) || attempt > now.getTime() || now.getTime() - attempt >= HOUR;
}
async function fetchConsumption({
  token,
  homeId,
  configRevision,
  now = new Date(),
  fetchImpl = fetch,
}) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Tibber token missing');
  if (homeId !== undefined && typeof homeId !== 'string') throw new Error('Invalid Tibber home ID');
  const { from, to } = monthWindow(now);
  if (to <= from) return null; // No completed hour in the new month yet.
  async function request(query, variables) {
    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new Error('Tibber consumption network request failed');
    }
    if (!response.ok) throw new Error('Tibber consumption HTTP request failed');
    let json;
    try {
      json = await response.json();
    } catch {
      throw new Error('Tibber consumption invalid JSON');
    }
    if (json?.errors?.length || !json?.data)
      throw new Error('Tibber consumption GraphQL request failed');
    return json.data;
  }
  const data = await request('query { viewer { homes { id } } }');
  const homes = data.viewer?.homes;
  if (!Array.isArray(homes)) throw new Error('Invalid Tibber homes response');
  const selected = homeId?.trim();
  const matches = selected ? homes.filter((h) => h?.id === selected) : homes;
  if (matches.length !== 1 || typeof matches[0]?.id !== 'string' || !matches[0].id)
    throw new Error('Select a valid Tibber home ID');
  const id = matches[0].id,
    rows = [];
  // Split the elapsed Stockholm month into <=744-hour requests (October can contain 745 hours).
  for (let end = to; end > from;) {
    const start = Math.max(from, end - 744 * HOUR);
    const page = await request(
      'query($id: ID!, $last: Int!, $before: String!) { viewer { home(id: $id) { id consumption(resolution: HOURLY, last: $last, before: $before, filterEmptyNodes: false) { nodes { from to consumption consumptionUnit } } } } }',
      {
        id,
        last: (end - start) / HOUR,
        before: Buffer.from(new Date(end).toISOString()).toString('base64'),
      },
    );
    const home = page.viewer?.home,
      nodes = home?.consumption?.nodes;
    if (
      home?.id !== id ||
      !Array.isArray(nodes) ||
      nodes.length > (end - start) / HOUR ||
      nodes.some((row) => !row || Date.parse(row.from) < start || Date.parse(row.to) > end)
    )
      throw new Error('Invalid Tibber consumption page');
    rows.push(...nodes);
    end = start;
  }
  return normalizeConsumption(rows, { configRevision, fetchedAt: now.toISOString(), from, to })
    .state;
}
module.exports = { monthWindow, shouldSync, fetchConsumption };
