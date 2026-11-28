'use strict';

const { createHash } = require('node:crypto');
const {
  bytes,
  dateKey,
  dailyFromSlots,
  SLOT_MS,
  SLOT_RETENTION,
  MAX_STATE_BYTES,
} = require('./history-format');

const FORMAT = 'quarter-days-v1';
const ROOT = 'historyState';
const dayKey = (date, bank) => 'quarterDay-' + date + '-' + bank;
const digest = (data) => createHash('sha256').update(data).digest('hex');
const emptyMeta = () => ({ daily: [], legacyDaily: [], events: [] });

// A root publication commits the open quarter, meter checkpoints and the exact
// versions of closed days together. Stage changed days in the inactive bank first.
class QuarterArchive {
  constructor(settings, pack, unpack) {
    this.settings = settings;
    this.pack = pack;
    this.unpack = unpack;
  }
  head() {
    const root = this.settings.get(ROOT);
    return root?.encoding === FORMAT ? root : null;
  }
  block(ref, key) {
    const value = this.settings.get(key);
    if (!value?.data || digest(value.data) !== ref.hash)
      throw Error('Missing or damaged quarter history block');
    return this.unpack(value);
  }
  meta(root) {
    return this.block(root.meta, 'quarterMeta-' + root.meta.bank);
  }
  rows(root, days = root.days, from = -Infinity, to = Infinity) {
    const rows = [];
    for (const day of days) {
      if (day.last < from || day.first >= to) continue;
      const part = this.block(day, dayKey(day.date, day.bank));
      rows.push(...part.filter((row) => row.t >= from && row.t < to));
    }
    if (root.open && root.open.t >= from && root.open.t < to) rows.push(structuredClone(root.open));
    return rows.sort((a, b) => a.t - b.t);
  }
  state(root, slots, meta) {
    return {
      ...structuredClone(root.header),
      ...meta,
      revision: root.revision,
      updatedAt: root.updatedAt,
      slots,
    };
  }
  startup(root, openT) {
    const slots = [];
    // Verify published blocks one day at a time. Only the current quarter is
    // needed to resume minute means and counter coverage after a restart.
    for (const day of root.days) {
      const part = this.block(day, dayKey(day.date, day.bank));
      const row = part.find((r) => r.t === openT);
      if (row) slots.push(row);
    }
    if (root.open?.t === openT) slots.push(structuredClone(root.open));
    return this.state(root, slots, this.meta(root));
  }
  read(root) {
    const state = this.state(root, this.rows(root), this.meta(root));
    if (root.live)
      state.daily = dailyFromSlots(state.slots, state.daily, Date.parse(root.updatedAt));
    return state;
  }
  update(times, now, hasEvents) {
    const root = this.head();
    if (!root) return null;
    const openT = Math.floor(now / SLOT_MS) * SLOT_MS;
    const changed = new Set();
    for (const t of times) if (t !== openT) changed.add(dateKey(t));
    if (root.open && root.open.t !== openT) changed.add(dateKey(root.open.t));
    // When a late repair touches today's archive, daily totals need every
    // retained quarter of that day, including the open one.
    if (root.openT !== openT || changed.size || hasEvents) changed.add(dateKey(openT));
    const cutoff = now - SLOT_RETENTION * SLOT_MS;
    if (root.days.some((day) => day.first < cutoff)) changed.add(dateKey(openT));
    const selected = root.days.filter((day) => changed.has(day.date) || day.first < cutoff);
    const untouched = root.days.filter((day) => !selected.includes(day));
    const hotOnly = !hasEvents && root.openT === openT && !selected.length && !changed.size;
    const state = this.state(
      root,
      this.rows(root, selected),
      hotOnly ? emptyMeta() : this.meta(root),
    );
    return { root, untouched, hotOnly, state };
  }
  fits(state, edit) {
    const otherBytes = edit.untouched.reduce((sum, d) => sum + d.logicalBytes, 0);
    const otherCount = edit.untouched.reduce((sum, d) => sum + d.count, 0);
    // Leave room for reconstructing today's summary on a hot-only checkpoint.
    return (
      state.slots.length + otherCount <= SLOT_RETENTION &&
      bytes(state) + otherBytes + (edit.hotOnly ? edit.root.meta.bytes : 0) + 2048 < MAX_STATE_BYTES
    );
  }
  write(state, expanded, edit) {
    const previous = this.head();
    if (
      (previous && previous.revision !== state.revision - 1) ||
      (edit && previous?.revision !== edit.root.revision)
    )
      throw Error('Quarter history revision changed');
    const { slots, daily, events, legacyDaily, revision, updatedAt, ...header } = state;
    const openT = Math.floor(Date.parse(updatedAt) / SLOT_MS) * SLOT_MS;
    const days = [...(edit?.untouched ?? [])];
    const groups = new Map();
    let open = null;
    for (const [index, row] of slots.entries()) {
      if (row.t === openT) {
        open = row;
        continue;
      }
      const date = dateKey(row.t);
      if (!groups.has(date)) groups.set(date, { rows: [], logicalBytes: 0 });
      const group = groups.get(date);
      group.rows.push(row);
      group.logicalBytes += bytes(expanded[index]) + 1;
    }
    for (const [date, { rows, logicalBytes }] of groups) {
      const old = previous?.days.find((d) => d.date === date);
      const value = this.pack(rows),
        hash = digest(value.data);
      if (old?.date === date && old.hash === hash) {
        days.push(old);
        continue;
      }
      const bank = old?.bank === 0 ? 1 : 0;
      this.settings.set(dayKey(date, bank), value);
      days.push({
        date,
        bank,
        hash,
        first: rows[0].t,
        last: rows.at(-1).t,
        count: rows.length,
        logicalBytes,
      });
    }
    days.sort((a, b) => a.first - b.first);
    let meta = previous?.meta;
    if (!edit?.hotOnly) {
      const value = this.pack({ daily, events, legacyDaily }),
        hash = digest(value.data);
      if (meta?.hash !== hash) {
        const bank = meta?.bank === 0 ? 1 : 0;
        this.settings.set('quarterMeta-' + bank, value);
        meta = { bank, hash, bytes: value.bytes };
      }
    }
    const root = {
      encoding: FORMAT,
      revision,
      updatedAt,
      header: structuredClone(header),
      openT,
      open: structuredClone(open),
      days,
      live: !!edit?.hotOnly,
      archiveRevision: edit?.hotOnly ? previous.archiveRevision : revision,
      meta,
    };
    this.settings.set(ROOT, root);
    if (!edit?.hotOnly) this.cleanup(root, previous);
  }
  cleanup(root, previous) {
    if (!this.settings.unset) return;
    const active = new Set(root.days.map((d) => dayKey(d.date, d.bank)));
    active.add('quarterMeta-' + root.meta.bank);
    try {
      // A previous interrupted migration/import can also leave unpublished banks.
      const keys = this.settings.getKeys?.() ?? [
        ...(previous?.days ?? []).map((d) => dayKey(d.date, d.bank)),
        'quarterMeta-0',
        'quarterMeta-1',
      ];
      for (const k of keys)
        if (/^quarter(?:Day-\d{4}-\d{2}-\d{2}|Meta)-[01]$/.test(k) && !active.has(k))
          this.settings.unset(k);
    } catch {
      /* Cleanup can retry after the next closed-quarter commit. */
    }
  }
}
module.exports = { QuarterArchive, FORMAT };
