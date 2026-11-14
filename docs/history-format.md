# History format and sampling

Quarter-hour records introduced by issue #5 retain `schema: 2`. Issue #6 stores them with daily summaries and events in a single `historyState` setting with schema 3. History remains bounded app-settings storage, not a billing meter or a database.

## Record fields

| Field | Meaning |
| --- | --- |
| `t` | Start of the UTC-aligned quarter, in epoch milliseconds |
| `counts` | Number of accepted finite observations for each field (`gridW`, `pvW`, `essW`, `soc`, `evW`, `evSoc`) |
| `sum`, `min`, `max` | Per-field observation statistics; missing fields are omitted |
| `n` | Number of append calls with at least one accepted observation; retained for compatibility, never the denominator for field averages |
| `gridWh`, `pvWh`, `essWh`, `evWh` | Signed trapezoidal energy integrals; absent until an eligible observation pair exists |
| `importWh`, `exportWh` | Nonnegative directional grid integrals for newly observed segments; both may be positive within one quarter |
| `directionalCoverageMs` | Duration covered by those directional integrals; missing means unknown, not zero |
| `coverageMs` | Integrated grid-power duration in this quarter; EVDC samples do not affect it |
| `essCoverageMs` | Battery integral coverage recorded for new ESS observation pairs; full 900,000 ms is required by the balanced replay, independently of grid coverage |
| `legacy` | Original older record, only when new observations overlap its quarter; retained for export, excluded from the new record's statistics and energy |

For each field, the displayed sample mean is `sum[field] / counts[field]`. It is a sample mean, not a time-weighted mean. Missing counts or missing observations produce an unknown value, not zero. An observed zero still counts as a real value.

## Continuity and energy

Each field keeps an independent in-memory timestamp/value anchor. Plant and EVDC samples may arrive separately, including at the same timestamp. A duplicate or backward timestamp for an already observed field is ignored; a complementary field at that timestamp may still be accepted. An explicit invalid value breaks only that field's continuity; an absent field leaves its stream untouched.

Energy is integrated only between valid observations no more than 60 seconds apart. Linear interpolation splits short intervals at quarter boundaries; each segment contributes only to its own quarter, without dropping or double-counting the boundary interval. Longer gaps are not filled. Grid continuity also breaks on reader/connection changes, failed plant reads and off-grid/unknown grid-mode samples. These events cannot bridge a brief gap just because its duration is below 60 seconds.

For new grid observation pairs, import and export are integrated separately. An interval that crosses zero is split at its linearly interpolated crossing before the positive and negative triangles are accumulated. The existing signed `gridWh` is retained, so `importWh - exportWh` equals it when directional coverage spans the entire net-energy coverage. This is an approximation from sampled power, not an inverter meter counter or settlement measurement; sub-sample changes remain unknown. Native Homey Energy cumulative registers and Tibber references are separate sources.

When newly observed segments overlap an existing net-only schema-2 quarter, its net energy and old coverage remain intact. Directional fields describe only the newly observed portion and have their own coverage. Old import/export volumes are not inferred from the sign of old net energy. Economic eligibility requires a closed quarter with full 900,000 ms of both net and directional coverage and consistent finite directional totals. A full net-coverage quarter with only partial directional coverage stays excluded. An energy-only boundary segment can exist without an observation count in that quarter.

Flushing retains in-memory continuity; app restart does not. New observations after restart can add statistics to an existing schema-2 record, but no energy is inferred over the restart gap. Per-field duplicate/backward rejection applies within the running instance; old observation anchors are not reconstructed from persisted aggregates.

## Existing history

Older records have no reliable per-field counts, so settings and widget views do not derive means from their shared `n`. Earlier quarters remain unchanged. If new samples overlap an older active quarter, the original record is saved under `legacy` and a separate schema-2 record accumulates only the new observations. Its coverage therefore remains partial until genuinely observed; old coverage is not borrowed to qualify an hour for tariff calculation.

This does not retroactively repair older energy integrals or daily totals. Older, non-overlapping records continue to be retained/exported and existing calculation modules may still use their recorded energy/coverage. The storage, daily aggregation and restore rules below implement the next stage of issue #6. The fix does not validate tariffs, financial accuracy, hardware register profiles or the Dashboard runtime.


## Single snapshot and retention

`historyState` contains schema 3, timezone, revision, updatedAt, slots, daily, events and legacyDaily. A normal flush performs one settings write for the whole snapshot, instead of independently saving quarters and daily totals. Pending samples are cleared only after success. A failed write leaves the previous committed snapshot available and pending samples retryable within the running process. An app restart retains committed data; it cannot recover samples that were never successfully saved. This is a single-key application commit, not a claim of power-loss-safe filesystem transactions.

Detailed retention is 32 days, capped at 3,072 UTC-aligned quarters. This accommodates a full 31-day Stockholm calendar month, including the extra autumn DST hour. It does not retain all prior billing months indefinitely or manufacture missing intervals. Export completed periods if you need their raw detail later.

Daily records use schema 3 and Europe/Stockholm dates. Each contains energy totals, observed slot count, grid coverage, expected day duration, observed peak, sourceFrom/sourceTo and legacySlots. A complete day requires all its quarters and full grid coverage with no legacy slots. Optional directional daily totals and their coverage sum only observed directional segments; they do not change the existing net-completeness status. Daily directional volumes may therefore remain partial even when net coverage is complete. Displayed daily energy totals are rounded to hundredths of Wh, while directional coverage remains exact. A spring day expects 92 quarters, an autumn day 100. Other days and gaps remain partial. Recalculation must cover at least the old source range, observed slot count and coverage; a retained suffix or sparse subset cannot truncate an archived total. Days are retained by calendar date for 730 days.

On first successful flush, the new state is built from the old history keys. Those keys are left untouched as migration evidence; runtime calculations and views prefer historyState thereafter. Old UTC daily records are kept in legacyDaily, not relabelled as Stockholm days. New local totals can be reconstructed only from raw records still available. Older energy/daily errors are not retroactively repaired. Downgrading to a version that only reads the frozen old keys is not a supported way to access newly collected history.

Events remain capped at 500; identical events are deduplicated on timestamp, type and permitted details. Backup-mode events trigger an immediate history flush. Ordinary samples are flushed once per minute when there is pending data. Empty flushes do not write.

## Export and restore

Both app settings and `HistoryStore.export()` now use the same authenticated backend export, with these top-level fields (synthetic format example):

```json
{
  "format": "com.local.sigenergy.history",
  "schema": 5,
  "timezone": "Europe/Stockholm",
  "exportedAt": "2026-06-10T00:00:00.000Z",
  "slots": [],
  "daily": [],
  "events": [],
  "legacyDaily": []
}
```

The settings page selects a local JSON file, asks the server for a preview, then offers a separate merge action. No import is applied by selecting a file. Preview includes live pending data without writing it; apply recalculates against the current state. Existing quarters and archived days win conflicts, and overlapping energy is never summed. Raw records outside the retained window are not restored to that window, but valid daily summaries may remain within daily retention. Daily summaries are recalculated only when the available source is at least as complete as the archive.

Canonical schema-3 history exports remain accepted without directional fields. New exports use schema 5 for independent battery coverage; schema 4 introduced the directional extension. Valid schema-4 files remain accepted without inferred ESS coverage; older app versions cannot read these new backups. The in-memory/stored state and daily record schemas stay 3, and quarter record schema stays 2. Keep a backup made before upgrading if you need to downgrade. Directional fields must appear as a complete nonnegative pair with finite coverage no greater than net coverage; complete directional coverage must agree with signed net energy.

Legacy schema 1/2 exports are accepted in either the slots/daily/events form or the old settings-page historySlots/historyDaily/historyEvents form. All three collections are required. Unknown versions/fields, credential-bearing fields, malformed dates, future records, unaligned/duplicate quarters, inconsistent counts, impossible coverage, excessive counts and invalid nested legacy data are rejected before any write. UTC daily summaries from legacy files go to legacyDaily. Unknown fields are rejected rather than silently applied as settings.

Restore only merges history; it never restores hosts, API tokens, charging configuration, operation mode or hardware controls. Inverter state writes use the same single-key commit; the combined meter backup has the separate-commit boundary below. A failed apply can be retried without adding overlapping energy twice. The format records observed aggregates, not authenticity or meter calibration; an externally edited but structurally valid file is not verified hardware evidence.

Routes in api.js are authenticated (`public: false`): GET /history/export, POST /history/import/preview and POST /history/import. They follow the [Homey App Web API](https://apps.developer.homey.app/advanced/web-api) and [settings-view API](https://apps.developer.homey.app/advanced/custom-views/app-settings) contracts.

## Size budget and measurements

The new snapshot has an explicit 4 MiB serialized-JSON budget. Import files are limited to 8 MiB, with stricter collection and final merged-state bounds. A budget error leaves committed history intact; no old data is silently deleted to make an oversized import fit. The frozen migration keys occupy additional space and are not included in the new snapshot budget. Manual exports contain private usage patterns and must be kept private.

A synthetic 32-day fixture with all six observation fields, directional grid energy and independent ESS coverage produces 3,072 quarters and 32 daily summaries in 1,547,377 serialized bytes, with one canonical write. This is a local in-memory test, not a Homey performance/storage measurement. Run `node scripts/benchmark-history.js` to repeat it without accessing Homey or private data.

The budget is an application policy, not an established Homey storage ceiling. Tests inject write failures and restart the store against committed snapshots. Full-window storage latency, a new-format physical restart, browser/API transport of large exports, and physical preview/restore still require staged testing after review. Issue #6 remains open for that verification. [Homey's persistence documentation](https://apps.developer.homey.app/the-basics/app/persistent-storage) says app settings survive restarts and are deleted on uninstall; no database, automatic external backup or durability guarantee is inferred.

## Combined backup and meter archive

The authenticated settings-page export wraps the existing inverter history in `{format: "com.local.sigenergy.backup", schema: 1, exportedAt, history, meter}`. `history` uses the schema-5 export described above; `meter` is null or the validated 13-month `tibberConsumptionArchive`. Existing schema-1/2/3/4/5 history-only files remain accepted and do not alter meter references. Compact JSON keeps a valid maximum-budget bundle below the 8 MiB file limit. The meter archive has its own 1 MiB budget; the inverter snapshot retains its 4 MiB budget. These are application limits, not measured Homey storage guarantees.

Preview validates both sections before any write and reports retained meter month/hour counts, overlapping hours and whether rebinding is needed. Existing meter hours win overlaps, missing hours may be filled, and energy is never summed twice. The 13-month retention window also applies on import; expired months are not reintroduced. A later successful Tibber fetch can still replace a monthly snapshot with provider corrections.

The backup contains a random configuration revision, not a token or connection fingerprint. If its revision differs from the current Tibber configuration, restore is blocked until the user explicitly confirms that the file belongs to the currently configured home. A saved Tibber token/configuration is required. This confirmation is a user assertion, not independent home-identity verification. Preview and apply recompute the binding against current settings. Never rebind another household's data. No credentials, hosts, cost contracts, operation mode, device controls or scheduler success/error state are restored.

Inverter history and meter archive are separate settings commits, **not one atomic transaction**. Both sections are validated before either write. The meter archive is written first; if that write fails, inverter history is untouched. If the later inverter write fails, the API explicitly reports that meter references were saved and instructs the user to retry the same backup. Existing-wins merges are idempotent, so retrying completes the operation without double-counting. Pending live inverter samples are preserved on a failed history commit. A complete-success response is returned only after both commits finish. A process interruption between commits has the same retry requirement; keep the original backup until recovery is confirmed.

The Dashboard continues to show only the current-month summary. Retained prior-month hourly references are in the private export and can be evaluated through `getMeterDemandCharge(month)` with the currently configured tariff; they are not archived tariff contracts or final invoices. Full archive/restore transport and failure recovery on physical Homey remain to be verified after release. Issue #6 remains open.

## Dated economic comparison

The independent ESS coverage field, dated cost/tariff archive and balanced replay are described in [economic replay](economic-replay.md). Older energy is retained but not promoted to complete battery coverage. Export schema 5 is not readable by older app versions; retain a pre-upgrade backup for downgrade. Dated cost versions have a separate private export and are not part of the combined history/meter backup.
