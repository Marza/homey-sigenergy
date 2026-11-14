'use strict';
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { DataError, ORIGIN, QUARTER, fetchPriceWindow } = require('./tibber-data-prices');
const { getEnergyHistory } = require('./energy-history');
const { observedCosts, contractHash } = require('./observed-costs');
const { validateCostContract } = require('./cost-model');
const REDIRECT = 'https://callback.athom.com/oauth2/callback';
const AUTH = 'https://thewall.tibber.com/connect/authorize',
  TOKEN = 'https://thewall.tibber.com/connect/token';
const SCOPES =
  'openid profile email offline_access data-api-user-read data-api-homes-read data-api-prices-read';
const SESSION = 'tibberDataSession',
  CACHE = 'tibberDataPriceCache',
  SYNC = 'tibberDataSync',
  OPTIONS = 'tibberDataOptions';
function text(v, max = 16384) {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !/[\r\n]/.test(v);
}
function safeCache(cache, revision, now) {
  if (
    !cache ||
    cache.revision !== revision ||
    !Number.isFinite(cache.fetchedAt) ||
    cache.fetchedAt > now ||
    !Array.isArray(cache.rows) ||
    cache.rows.length > 3400
  )
    return null;
  const seen = new Set(),
    detail = (d) =>
      d &&
      Number.isFinite(d.price) &&
      Math.abs(d.price) <= 1000000 &&
      Number.isFinite(d.vat) &&
      d.vat >= 0 &&
      d.vat <= 100;
  if (
    cache.rows.some(
      (r) =>
        !Number.isSafeInteger(r?.t) ||
        r.t < 0 ||
        r.t % QUARTER ||
        seen.has(r.t) ||
        (seen.add(r.t), false) ||
        !detail(r.consumption) ||
        (r.production && !detail(r.production)),
    )
  )
    return null;
  return cache;
}
class TibberData {
  constructor(homey, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.homey = homey;
    this.fetch = fetchImpl;
    this.now = now;
    this.stopped = false;
    this.authGeneration = 0;
  }
  session() {
    return this.homey.settings.get(SESSION);
  }
  current(revision) {
    return !this.stopped && this.session()?.revision === revision;
  }
  write(key, value) {
    if (this.stopped) throw new DataError('stopped');
    this.homey.settings.set(key, value);
  }
  async json(url, opts = {}) {
    let r;
    try {
      r = await this.fetch(url, { ...opts, redirect: 'error', signal: AbortSignal.timeout(12000) });
    } catch {
      throw new DataError('network-error');
    }
    if (!r.ok) {
      const retry = Number(r.headers?.get('retry-after'));
      throw new DataError(
        r.status === 401
          ? 'authorization-required'
          : r.status === 403
            ? 'scope-or-prices-unavailable'
            : r.status === 429
              ? 'rate-limited'
              : 'upstream-unavailable',
        r.status === 429 && Number.isFinite(retry) && retry > 0
          ? Math.min(86400000, Math.max(60000, retry * 1000))
          : 3600000,
      );
    }
    let data;
    try {
      const body = await r.text();
      if (body.length > 2 * 1024 * 1024) throw Error();
      data = JSON.parse(body);
    } catch {
      throw new DataError('invalid-response');
    }
    return data;
  }
  async exchange(clientId, params, old) {
    const response = await this.json(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...params }).toString(),
    });
    if (
      !text(response.access_token) ||
      !text(response.refresh_token || old?.refresh) ||
      !Number.isFinite(response.expires_in) ||
      response.expires_in <= 0 ||
      response.expires_in > 86400 ||
      String(response.token_type).toLowerCase() !== 'bearer'
    )
      throw new DataError('invalid-token-response');
    return {
      access: response.access_token,
      refresh: response.refresh_token || old.refresh,
      expiresAt: this.now() + response.expires_in * 1000,
    };
  }
  async access(force = false, rejected) {
    const s = this.session();
    if (!s?.token) throw new DataError('authorization-required');
    if (
      (!force && s.token.expiresAt > this.now() + 60000) ||
      (rejected && s.token.access !== rejected)
    )
      return s.token.access;
    if (this.refreshing) {
      await this.refreshing;
      if (!this.current(s.revision)) throw new DataError('configuration-changed');
      return this.session().token.access;
    }
    this.refreshing = (async () => {
      const token = await this.exchange(
        s.clientId,
        { grant_type: 'refresh_token', refresh_token: s.token.refresh },
        s.token,
      );
      if (!this.current(s.revision)) throw new DataError('configuration-changed');
      this.write(SESSION, { ...this.session(), token });
      return token.access;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }
  async request(url) {
    const revision = this.session()?.revision,
      token = await this.access();
    if (!this.current(revision)) throw new DataError('configuration-changed');
    try {
      const result = await this.json(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!this.current(revision)) throw new DataError('configuration-changed');
      return result;
    } catch (e) {
      if (e.code !== 'authorization-required') throw e;
      if (!this.current(revision)) throw new DataError('configuration-changed');
      const refreshed = await this.access(true, token);
      const result = await this.json(url, { headers: { Authorization: `Bearer ${refreshed}` } });
      if (!this.current(revision)) throw new DataError('configuration-changed');
      return result;
    }
  }
  async connect({ clientId } = {}) {
    if (typeof clientId !== 'string' || !/^[-a-zA-Z0-9._]{1,200}$/.test(clientId))
      throw new DataError('invalid-client');
    this.cancelAuth?.();
    const generation = ++this.authGeneration,
      verifier = randomBytes(48).toString('base64url');
    const url = new URL(AUTH);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: SCOPES,
      state: randomBytes(32).toString('hex'),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    this.authStatus = 'authorizing';
    // Homey's documented relay owns callback routing/state; PKCE binds the code
    // to this backend-only verifier. No public callback route or secret in UI.
    let callback;
    try {
      callback = await this.homey.cloud.createOAuth2Callback(url.href);
    } catch {
      this.authStatus = 'authorization-failed';
      throw new DataError('authorization-failed');
    }
    if (this.stopped || generation !== this.authGeneration)
      throw new DataError('configuration-changed');
    return new Promise((resolve, reject) => {
      let expiry;
      this.cancelAuth = () => {
        this.homey.clearTimeout(timeout);
        if (expiry) this.homey.clearTimeout(expiry);
        reject(new DataError('configuration-changed'));
      };
      const timeout = this.homey.setTimeout(() => {
        if (generation === this.authGeneration) {
          this.authStatus = 'authorization-timeout';
          this.authGeneration++;
        }
        reject(new DataError('authorization-timeout'));
      }, 10000);
      callback.on('url', (login) => {
        if (generation !== this.authGeneration || this.stopped) return;
        let u;
        try {
          u = new URL(login);
        } catch {
          this.cancelAuth();
          this.authGeneration++;
          this.authStatus = 'invalid-login-url';
          reject(new DataError('invalid-login-url'));
          return;
        }
        if (
          u.protocol !== 'https:' ||
          !['callback.athom.com', 'thewall.tibber.com'].includes(u.hostname) ||
          u.username ||
          u.password
        ) {
          this.cancelAuth();
          this.authGeneration++;
          this.authStatus = 'invalid-login-url';
          reject(new DataError('invalid-login-url'));
          return;
        }
        this.homey.clearTimeout(timeout);
        expiry = this.homey.setTimeout(() => {
          if (generation === this.authGeneration) {
            this.authGeneration++;
            this.authStatus = 'authorization-timeout';
          }
        }, 600000);
        resolve({ url: u.href, redirectUri: REDIRECT });
      });
      const expires = this.now() + 600000;
      callback.on('code', (code) => {
        if (generation !== this.authGeneration || this.stopped || this.now() > expires) return;
        this.cancelAuth();
        this.authGeneration++;
        if (code instanceof Error || !text(code)) {
          this.authStatus = 'authorization-failed';
          return;
        }
        this.exchange(clientId, {
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
        })
          .then((token) => {
            if (this.stopped || this.authGeneration !== generation + 1) return;
            this.write(SESSION, {
              schema: 1,
              revision: randomUUID(),
              clientId,
              token,
              homeId: null,
            });
            this.write(CACHE, null);
            this.write(SYNC, null);
            this.write(OPTIONS, null);
            this.authStatus = null;
          })
          .catch(() => {
            if (!this.stopped && this.authGeneration === generation + 1)
              this.authStatus = 'authorization-failed';
          });
      });
    });
  }
  async homes() {
    const data = await this.request(`${ORIGIN}/v1/homes`);
    if (
      !Array.isArray(data?.homes) ||
      data.homes.length > 100 ||
      data.homes.some(
        (h) =>
          !text(h.id, 200) ||
          !/^[-a-zA-Z0-9_]+$/.test(h.id) ||
          typeof h.name !== 'string' ||
          h.name.length > 500,
      )
    )
      throw new DataError('invalid-response');
    return data.homes.map((h) => ({ id: h.id, name: h.name }));
  }
  async selectHome({ homeId, confirmSamePlant } = {}) {
    if (confirmSamePlant !== true) throw new DataError('home-confirmation-required');
    const s = this.session();
    const homes = await this.homes();
    if (!homes.some((h) => h.id === homeId) || !this.current(s.revision))
      throw new DataError('invalid-home');
    this.write(SESSION, { ...this.session(), homeId, revision: randomUUID() });
    this.write(CACHE, null);
    this.write(SYNC, null);
    this.write(OPTIONS, null);
    return this.status();
  }
  options({ includeNetwork, confirmSeparateNetworkComponents } = {}) {
    const s = this.session();
    if (!s?.homeId) throw new DataError('select-home');
    if (typeof includeNetwork !== 'boolean') throw new DataError('invalid-options');
    let hash = null;
    if (includeNetwork) {
      const c = validateCostContract(this.homey.settings.get('costContract'));
      if (
        confirmSeparateNetworkComponents !== true ||
        c.importPriceBasis !== 'spot-ex-vat' ||
        c.importIncludesEnergyTax
      )
        throw new DataError('network-confirmation-required');
      hash = contractHash(c);
    }
    this.write(OPTIONS, { includeNetwork, costHash: hash, revision: s.revision });
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
      now = this.now();
    if (this.stopped || !s?.homeId) return this.status();
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
    const history = getEnergyHistory(this.homey, now),
      from = history.slots[0]?.t ?? Math.floor(now / QUARTER) * QUARTER;
    this.write(SYNC, {
      revision: s.revision,
      status: 'fetching',
      lastAttemptAt: now,
      nextAttemptAt: now + 3600000,
    });
    try {
      const rows = await fetchPriceWindow((url) => this.request(url), s.homeId, from, now);
      if (!this.current(s.revision)) return this.status();
      const old = safeCache(this.homey.settings.get(CACHE), s.revision, now),
        byTime = new Map(old?.rows.map((r) => [r.t, r]) || []);
      for (const r of rows) {
        byTime.set(r.t, r);
      }
      const kept = [...byTime.values()]
        .filter((r) => r.t >= now - 32 * 86400000 && r.t < now + 3 * 86400000)
        .sort((a, b) => a.t - b.t);
      const cache = { schema: 1, revision: s.revision, fetchedAt: now, rows: kept };
      if (kept.length > 3400 || Buffer.byteLength(JSON.stringify(cache)) > 2 * 1024 * 1024)
        throw new DataError('cache-limit');
      this.write(CACHE, cache);
      // Retry hourly until tomorrow is covered, then refresh once per day.
      const { calendar } = require('./coverage'),
        tomorrow = calendar(new Date(now)).tomorrow;
      const future = new Set(kept.map((r) => r.t));
      let complete = true;
      for (let t = tomorrow.start; t < tomorrow.end; t += QUARTER)
        if (!future.has(t)) complete = false;
      const next = complete ? now + 24 * 3600000 : now + 3600000;
      this.write(SYNC, {
        revision: s.revision,
        status: 'ok',
        lastAttemptAt: now,
        lastSuccessAt: now,
        nextAttemptAt: next,
      });
    } catch (e) {
      if (this.current(s.revision))
        this.write(SYNC, {
          revision: s.revision,
          status: e instanceof DataError ? e.code : 'price-fetch-failed',
          lastAttemptAt: now,
          nextAttemptAt: now + (e.retryMs || 3600000),
        });
    }
    return this.status();
  }
  status() {
    const s = this.session(),
      now = this.now(),
      cache = safeCache(this.homey.settings.get(CACHE), s?.revision, now),
      state = this.homey.settings.get(SYNC);
    return {
      connected: !!s?.token,
      clientId: s?.clientId || null,
      homeId: s?.homeId || null,
      authStatus: this.authStatus || null,
      redirectUri: REDIRECT,
      priceRows: cache?.rows.length || 0,
      fetchedAt: cache?.fetchedAt || null,
      syncStatus: state?.revision === s?.revision ? state?.status || null : null,
      nextAttemptAt: state?.revision === s?.revision ? state?.nextAttemptAt || null : null,
      includeNetwork:
        this.homey.settings.get(OPTIONS)?.revision === s?.revision &&
        !!this.homey.settings.get(OPTIONS)?.includeNetwork,
    };
  }
  ledger() {
    const s = this.session();
    return observedCosts(
      this.homey,
      s,
      safeCache(this.homey.settings.get(CACHE), s?.revision, this.now()),
      this.homey.settings.get(OPTIONS),
      this.now(),
    );
  }
  disconnect() {
    this.cancelAuth?.();
    this.authGeneration++;
    this.authStatus = null;
    this.write(SESSION, null);
    this.write(CACHE, null);
    this.write(SYNC, null);
    this.write(OPTIONS, null);
    return this.status();
  }
  stop() {
    this.cancelAuth?.();
    this.stopped = true;
    this.authGeneration++;
  }
}
module.exports = { TibberData, REDIRECT, SCOPES, safeCache };
