'use strict';
const { createHash } = require('node:crypto');
const { HOUR, PriceError, fetchHistoryPrices } = require('./tibber-history-fetch');
const { getEnergyHistory } = require('./energy-history');
const { observedCosts, contractHash } = require('./observed-costs');
const { validateCostContract } = require('./cost-model');
const CACHE = 'tibberHistoryPriceCache',
  SYNC = 'tibberHistoryPriceSync',
  OPTIONS = 'tibberHistoryPriceOptions';
function safeCache(c, revision, now) {
  if (
    !c ||
    c.schema !== 1 ||
    c.revision !== revision ||
    !Number.isFinite(c.fetchedAt) ||
    c.fetchedAt > now ||
    !Array.isArray(c.rows) ||
    c.rows.length > 768
  )
    return null;
  const seen = new Set();
  for (const r of c.rows) {
    if (
      !Number.isSafeInteger(r?.t) ||
      r.t < 0 ||
      r.t % HOUR ||
      r.t + HOUR > c.fetchedAt ||
      seen.has(r.t)
    )
      return null;
    seen.add(r.t);
    for (const d of [r.consumption, r.production])
      if (d && (!Number.isFinite(d.price) || Math.abs(d.price) > 1e6)) return null;
  }
  return c;
}
class TibberHistoryPrices {
  constructor(homey, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.homey = homey;
    this.fetch = fetchImpl;
    this.now = now;
    this.stopped = false;
  }
  session() {
    const token = String(this.homey.settings.get('tibberToken') || '').trim(),
      homeId = String(this.homey.settings.get('tibberHomeId') || '').trim();
    const revision = this.homey.settings.get('sourceConfig')?.tibber?.revision;
    const existing = this.homey.settings.get('priceCache');
    const resolvedHome =
      homeId ||
      (existing?.configRevision === revision && !existing.selectedHomeId ? existing.homeId : '');
    if (!token || !revision) return null;
    // Private fingerprint guards changes even before the app listener runs.
    return {
      token,
      homeId: resolvedHome,
      revision: createHash('sha256')
        .update(JSON.stringify([revision, token, homeId, resolvedHome]))
        .digest('hex'),
    };
  }
  current(revision) {
    return !this.stopped && this.session()?.revision === revision;
  }
  write(key, value) {
    if (this.stopped) throw new PriceError('stopped');
    this.homey.settings.set(key, value);
  }
  confirm({ confirmSamePlant } = {}) {
    const s = this.session();
    if (!s?.homeId) throw new PriceError('select-home');
    if (confirmSamePlant !== true) throw new PriceError('home-confirmation-required');
    this.write(OPTIONS, { revision: s.revision, confirmed: true, includeNetwork: false });
    return this.status();
  }
  options({ includeNetwork, confirmSeparateNetworkComponents } = {}) {
    const s = this.session(),
      old = this.homey.settings.get(OPTIONS);
    if (!s || old?.revision !== s.revision || !old.confirmed)
      throw new PriceError('home-confirmation-required');
    if (typeof includeNetwork !== 'boolean') throw new PriceError('invalid-options');
    let hash = null;
    if (includeNetwork) {
      const c = validateCostContract(this.homey.settings.get('costContract'));
      if (
        confirmSeparateNetworkComponents !== true ||
        c.importPriceBasis !== 'spot-ex-vat' ||
        c.importIncludesEnergyTax
      )
        throw new PriceError('network-confirmation-required');
      hash = contractHash(c);
    }
    this.write(OPTIONS, { ...old, includeNetwork, costHash: hash });
    return this.status();
  }
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync();
    return this.syncing.finally(() => {
      this.syncing = null;
    });
  }
  async runSync() {
    const s = this.session(),
      now = this.now(),
      options = this.homey.settings.get(OPTIONS);
    if (this.stopped || !s?.homeId || options?.revision !== s.revision || !options.confirmed)
      return this.status();
    const state = this.homey.settings.get(SYNC);
    if (
      state?.revision === s.revision &&
      Number.isFinite(state.lastAttemptAt) &&
      state.lastAttemptAt <= now &&
      Number.isFinite(state.nextAttemptAt) &&
      state.nextAttemptAt > now &&
      state.nextAttemptAt <= state.lastAttemptAt + 86400000
    )
      return this.status();
    const energy = getEnergyHistory(this.homey, now),
      to = Math.floor(now / HOUR) * HOUR;
    const from = Math.max(
      Math.floor((energy.slots[0]?.t ?? to) / HOUR) * HOUR,
      to - 32 * 24 * HOUR,
    );
    if (from >= to) {
      this.write(SYNC, {
        revision: s.revision,
        status: 'waiting-for-energy',
        lastAttemptAt: now,
        nextAttemptAt: now + HOUR,
      });
      return this.status();
    }
    this.write(SYNC, {
      revision: s.revision,
      status: 'fetching',
      lastAttemptAt: now,
      nextAttemptAt: now + HOUR,
    });
    try {
      const rows = await fetchHistoryPrices({
        token: s.token,
        homeId: s.homeId,
        from,
        to,
        fetchImpl: async (...args) => {
          if (!this.current(s.revision)) throw new PriceError('configuration-changed');
          const response = await this.fetch(...args);
          if (!this.current(s.revision)) throw new PriceError('configuration-changed');
          return response;
        },
      });
      if (!this.current(s.revision)) return this.status();
      const cache = { schema: 1, revision: s.revision, fetchedAt: now, rows };
      if (
        !safeCache(cache, s.revision, now) ||
        Buffer.byteLength(JSON.stringify(cache)) > 2 * 1024 * 1024
      )
        throw new PriceError('invalid-history');
      this.write(CACHE, cache);
      const complete =
        rows.length === (to - from) / HOUR && rows.every((r) => r.consumption && r.production);
      this.write(SYNC, {
        revision: s.revision,
        status: complete ? 'ok' : 'partial',
        lastAttemptAt: now,
        lastSuccessAt: now,
        nextAttemptAt: now + (complete ? 24 * HOUR : HOUR),
      });
    } catch (e) {
      if (this.current(s.revision))
        this.write(SYNC, {
          revision: s.revision,
          status: e instanceof PriceError ? e.code : 'history-fetch-failed',
          lastAttemptAt: now,
          nextAttemptAt: now + (e.retryMs || HOUR),
        });
    }
    return this.status();
  }
  status() {
    const s = this.session(),
      options = this.homey.settings.get(OPTIONS),
      state = this.homey.settings.get(SYNC),
      cache = safeCache(this.homey.settings.get(CACHE), s?.revision, this.now());
    return {
      configured: !!s,
      homeSelected: !!s?.homeId,
      confirmed: !!s && options?.revision === s.revision && !!options.confirmed,
      priceHours: cache?.rows.length || 0,
      fetchedAt: cache?.fetchedAt || null,
      syncStatus: state?.revision === s?.revision ? state?.status || null : null,
      nextAttemptAt: state?.revision === s?.revision ? state?.nextAttemptAt || null : null,
      includeNetwork: !!s && options?.revision === s.revision && !!options.includeNetwork,
    };
  }
  ledger() {
    const s = this.session(),
      options = this.homey.settings.get(OPTIONS);
    return observedCosts(
      this.homey,
      options?.confirmed && options.revision === s?.revision ? s : null,
      safeCache(this.homey.settings.get(CACHE), s?.revision, this.now()),
      options,
      this.now(),
    );
  }
  stop() {
    this.stopped = true;
  }
}
module.exports = { TibberHistoryPrices, safeCache };
