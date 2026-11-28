'use strict';
const { createHash } = require('node:crypto');
const { SLOT_MS: Q } = require('../history-format');
const { calculationSlot } = require('../history');
const { pack, unpack } = require('../packed-history');

const { solarAccuracy } = require('./solar-accuracy');
const { adjust, matchesSource, solarWh } = require('./solar-adjustment');

const CONFIG = 'solarForecastConfig';
const ARCHIVE = 'solarForecastIssuesV1';
const REPORT_QUARTERS = 96;
const PLANNING_QUARTERS = 2 * REPORT_QUARTERS;
const HOUR = Q * 4;
const WEEK = 7 * 24 * HOUR;
const VARIABLE = 'global_tilted_irradiance';

function number(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max)
    throw Error('Ogiltigt värde för ' + label);
  return value;
}
function validate(config) {
  if (!Array.isArray(config?.roofs) || !config.roofs.length || config.roofs.length > 4)
    throw Error('Ange 1–4 takytor.');
  return {
    enabled: true,
    latitude: number(config.latitude, -90, 90, 'latitud'),
    longitude: number(config.longitude, -180, 180, 'longitud'),
    loss: number(config.loss, 0, 99, 'systemförlust'),
    roofs: config.roofs.map((roof) => {
      const name = typeof roof?.name === 'string' && roof.name.trim();
      if (!name || name.length > 40) throw Error('Ange ett namn på högst 40 tecken per takyta.');
      return {
        name,
        kwp: number(roof.kwp, 0.001, 1000, 'kWp'),
        tilt: number(roof.tilt, 0, 90, 'lutning'),
        bearing: number(roof.bearing, 0, 360, 'kompassriktning'),
      };
    }),
  };
}
const signature = (config) => createHash('sha256').update(JSON.stringify(config)).digest('hex');

async function radiation(config, roof, request, signal) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: config.latitude,
    longitude: config.longitude,
    tilt: roof.tilt,
    azimuth: (roof.bearing % 360) - 180,
    minutely_15: VARIABLE,
    // The series starts at the current quarter and stamps radiation at interval end.
    // Allow for the request finishing one quarter after it started.
    forecast_minutely_15: PLANNING_QUARTERS + 3,
    timezone: 'GMT',
    timeformat: 'unixtime',
  });
  const response = await request(url, { signal });
  if (!response.ok) throw Error('Väderhämtningen misslyckades.');
  const data = await response.json(),
    times = data.minutely_15?.time,
    values = data.minutely_15?.[VARIABLE];
  if (
    data.minutely_15_units?.[VARIABLE] !== 'W/m²' ||
    !Array.isArray(times) ||
    !Array.isArray(values) ||
    times.length !== values.length ||
    !times.length
  )
    throw Error('Ogiltigt väderunderlag.');
  const byStart = new Map();
  for (const [i, time] of times.entries()) {
    if (!Number.isSafeInteger(time) || time % 900 || (i && time <= times[i - 1]))
      throw Error('Ogiltig vädertid.');
    // Open-Meteo stamps mean radiation at the END of the preceding interval.
    const gti = values[i];
    if (Number.isFinite(gti) && gti >= 0) byStart.set(time * 1000 - Q, gti);
  }
  return byStart;
}

function firstDayRoofs(issue) {
  return issue.roofs.map((roof) => ({ ...roof, wh: roof.wh.slice(0, REPORT_QUARTERS) }));
}

function compare(issue, rows, source, now) {
  const actualWh = Array(REPORT_QUARTERS).fill(null);
  // The first forecast can complete before the paired reader starts on Homey.
  // Only compare that issue to a source covering the whole forecast from its start.
  if (matchesSource(issue, source)) {
    for (const raw of rows) {
      const i = (raw.t - issue.start) / Q;
      if (
        !Number.isInteger(i) ||
        i < 0 ||
        i >= REPORT_QUARTERS ||
        raw.t < source.since ||
        raw.t + Q > now
      )
        continue;
      const row = calculationSlot(raw);
      if (
        (row.energyFieldCoverageMs?.pvW ?? row.fieldCoverageMs?.pvW) === Q &&
        Number.isFinite(row.pvWh) &&
        row.pvWh >= 0
      )
        actualWh[i] = row.pvWh;
    }
  }
  return actualWh;
}
class SolarForecast {
  constructor(settings, history, { request = fetch, clock = Date.now } = {}) {
    this.settings = settings;
    this.history = history;
    this.request = request;
    this.clock = clock;
    this.retryAt = 0;
  }
  issues() {
    return (this.archive ??= unpack(this.settings.get(ARCHIVE)) ?? []);
  }
  configure(input) {
    if (typeof input?.enabled !== 'boolean') throw Error('Välj om solprognosen ska vara aktiv.');
    const config = input.enabled
      ? validate(input)
      : { ...this.settings.get(CONFIG), enabled: false };
    this.settings.set(CONFIG, config);
    this.controller?.abort();
    this.controller = null;
    this.retryAt = 0;
    this.failed = false;
    return config;
  }
  stop() {
    this.stopped = true;
    this.controller?.abort();
  }
  saveIssues(issues) {
    this.settings.set(ARCHIVE, pack(issues));
    this.archive = issues;
  }
  correctedIssues(issues, now) {
    const base = issues.at(-1);
    const source = this.settings.get('solarMeasurementSource');
    // Give the plant poll time to close the quarter after its boundary.
    const quarter = Math.floor(now / Q);
    if (now % Q < 60000 || now < base.at) return issues;
    const token = [base.at, quarter, source?.key, source?.since].join(':');
    const previous = base.adjustments?.at(-1);
    if (token === this.checkedAdjustment || previous?.token === token) return issues;
    const update =
      now - base.at < 2 * HOUR
        ? adjust(issues, source, now, () => this.history.getSlots((quarter - 4) * Q, quarter * Q))
        : null;
    if (!update && !previous?.wh) {
      this.checkedAdjustment = token;
      return issues;
    }
    // Also freeze a return to the weather baseline if the evidence lapses.
    const revision = { ...(update ?? { at: now, wh: null }), token };
    return [
      ...issues.slice(0, -1),
      { ...base, adjustments: [...(base.adjustments ?? []), revision] },
    ];
  }
  refreshAdjustment(key) {
    const issues = this.issues();
    if (issues.at(-1)?.key !== key) return;
    const next = this.correctedIssues(issues, this.clock());
    if (next !== issues) this.saveIssues(next);
  }
  async refresh() {
    const config = this.settings.get(CONFIG);
    const now = this.clock();
    if (!config?.enabled || this.stopped || this.controller) return;
    const key = signature(config);
    const previous = this.issues().at(-1);
    if (
      now < this.retryAt ||
      (previous?.key === key && previous.at <= now && now - previous.at < HOUR)
    ) {
      this.refreshAdjustment(key);
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    try {
      const maps = await Promise.all(
        config.roofs.map((roof) => radiation(config, roof, this.request, signal)),
      );
      if (signal.aborted || this.controller !== controller) return;
      const at = this.clock();
      const start = (Math.floor(at / Q) + 1) * Q;
      const roofs = config.roofs.map((roof, r) => ({
        ...roof,
        wh: Array.from({ length: PLANNING_QUARTERS }, (_, i) => {
          const gti = maps[r].get(start + i * Q);
          return gti === undefined
            ? null
            : Math.round(gti * roof.kwp * 0.25 * (1 - config.loss / 100));
        }),
      }));
      if (!roofs.some((roof) => roof.wh.some(Number.isFinite)))
        throw Error('Väderunderlag saknas.');
      const source = this.settings.get('solarMeasurementSource')?.key ?? null;
      const issue = { at, start, key, source, loss: config.loss, roofs };
      const archive = this.issues()
        .filter((entry) => entry.at > at - WEEK)
        .slice(-167);
      // Only the latest issue can supply the planner. Archive the original first day for comparison.
      if (archive.length) {
        const last = archive.at(-1);
        archive[archive.length - 1] = { ...last, roofs: firstDayRoofs(last) };
      }
      archive.push(issue);
      this.saveIssues(archive);
      this.failed = false;
    } catch {
      if (this.controller === controller && !this.stopped) {
        this.retryAt = this.clock() + 15 * 60000;
        this.failed = true;
      }
    } finally {
      controller.abort();
      if (this.controller === controller) this.controller = null;
    }
    if (!this.stopped && !this.controller) this.refreshAdjustment(key);
  }
  planningQuarters(now, todayEnd) {
    const config = this.settings.get(CONFIG);
    const result = new Map();
    if (!config?.enabled) return result;
    const issue = this.issues().at(-1);
    if (!issue || issue.key !== signature(config) || now < issue.at || now - issue.at >= 2 * HOUR)
      return result;
    const source = this.settings.get('solarMeasurementSource');
    const revision = matchesSource(issue, source)
      ? issue.adjustments?.findLast((item) => item.at <= now && item.at >= source.since)
      : null;
    for (
      let t = Math.max(issue.start, (Math.floor(now / Q) + 1) * Q);
      t < issue.start + issue.roofs[0].wh.length * Q;
      t += Q
    ) {
      const weather = solarWh(issue, t);
      if (weather === null) continue;
      const adjusted = t < todayEnd && revision?.wh ? revision.wh[(t - revision.start) / Q] : null;
      result.set(
        t,
        Number.isFinite(adjusted) && adjusted >= 0
          ? { solarWh: adjusted, solarSource: 'adjusted' }
          : { solarWh: weather, solarSource: 'weather' },
      );
    }
    return result;
  }
  report(selected) {
    const now = this.clock();
    const config = this.settings.get(CONFIG);
    const issues = this.issues().filter((i) => i.at > now - WEEK && i.at <= now);
    const latest = issues.at(-1);
    const current = config?.enabled && latest?.key === signature(config) ? latest : null;
    const issue = issues.find((i) => i.at === Number(selected)) ?? current;
    const source = this.settings.get('solarMeasurementSource');
    const rows = issue || current ? this.history.getSlots() : [];
    return {
      config,
      accuracy: current ? solarAccuracy(issues, current.key, rows, source, now) : null,
      issued: issues.map((i) => i.at),
      status: !config?.enabled
        ? 'off'
        : this.failed
          ? 'weather-error'
          : !current
            ? 'pending'
            : now - current.at >= 2 * HOUR
              ? 'stale'
              : 'ok',
      issue: issue
        ? {
            at: issue.at,
            start: issue.start,
            roofs: firstDayRoofs(issue),
            loss: issue.loss,
            adjustments: (issue.adjustments ?? []).map(
              ({ token: _token, ...revision }) => revision,
            ),
            actualWh: compare(issue, rows, source, now),
          }
        : null,
    };
  }
}
module.exports = { SolarForecast };
