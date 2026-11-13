# History format and sampling

The history fix for issue #5 writes quarter-hour records with `schema: 2`. Both JSON export paths also report top-level schema 2; existing export key names are unchanged. History remains bounded Homey app-settings storage, not a billing meter or a database.

## Record fields

| Field | Meaning |
| --- | --- |
| `t` | Start of the UTC-aligned quarter, in epoch milliseconds |
| `counts` | Number of accepted finite observations for each field (`gridW`, `pvW`, `essW`, `soc`, `evW`, `evSoc`) |
| `sum`, `min`, `max` | Per-field observation statistics; missing fields are omitted |
| `n` | Number of append calls with at least one accepted observation; retained for compatibility, never the denominator for field averages |
| `gridWh`, `pvWh`, `essWh`, `evWh` | Signed trapezoidal energy integrals; absent until an eligible observation pair exists |
| `coverageMs` | Integrated grid-power duration in this quarter; EVDC samples do not affect it |
| `legacy` | Original older record, only when new observations overlap its quarter; retained for export, excluded from the new record's statistics and energy |

For each field, the displayed sample mean is `sum[field] / counts[field]`. It is a sample mean, not a time-weighted mean. Missing counts or missing observations produce an unknown value, not zero. An observed zero still counts as a real value.

## Continuity and energy

Each field keeps an independent in-memory timestamp/value anchor. Plant and EVDC samples may arrive separately, including at the same timestamp. A duplicate or backward timestamp for an already observed field is ignored; a complementary field at that timestamp may still be accepted. An explicit invalid value breaks only that field's continuity; an absent field leaves its stream untouched.

Energy is integrated only between valid observations no more than 60 seconds apart. Linear interpolation splits short intervals at quarter boundaries; each segment contributes only to its own quarter, without dropping or double-counting the boundary interval. Longer gaps are not filled. An energy-only boundary segment can exist without an observation count in that quarter.

Flushing retains in-memory continuity; app restart does not. New observations after restart can add statistics to an existing schema-2 record, but no energy is inferred over the restart gap. Per-field duplicate/backward rejection applies within the running instance; old observation anchors are not reconstructed from persisted aggregates.

## Existing history

Older records have no reliable per-field counts, so settings and widget views do not derive means from their shared `n`. Earlier quarters remain unchanged. If new samples overlap an older active quarter, the original record is saved under `legacy` and a separate schema-2 record accumulates only the new observations. Its coverage therefore remains partial until genuinely observed; old coverage is not borrowed to qualify an hour for tariff calculation.

This does not retroactively repair older energy integrals or daily totals. Older, non-overlapping records continue to be retained/exported and existing calculation modules may still use their recorded energy/coverage. Daily timezone, full-month retention, storage and restore improvements are tracked separately in issue #6. The fix does not validate tariffs, financial accuracy, hardware register profiles or the Dashboard runtime.
