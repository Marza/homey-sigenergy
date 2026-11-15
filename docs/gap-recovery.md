# Energy-gap recovery

Recovery runs automatically with the existing opt-in **Sigenergy V2.9 energy-counter profile** and the confirmed existing Tibber connection. It adds no Modbus writes, credentials, additional device or additional counter polling. Power-only installations continue collecting power without counter recovery.

## Small Sigenergy gaps

The existing once-per-minute cumulative-energy probe can supply separate grid import/export, battery charge/discharge and the selected own/third-party/combined solar channel. The collector retains a short in-memory ledger of the actual power intervals between counter observations.

A counter pair can estimate missing energy only when:

- Both observations have valid nondecreasing counters and the same connection/profile/source/reference generation.
- The observations are at most **five minutes apart**, and their interval and conservative client collection margin belong entirely to **one quarter**. A pair ending in the final two seconds of a quarter, or at its boundary, is not used.
- The entire current polling/collection window is at most **two seconds**, and the power-interval ledger accounts for the complete counter interval.
- At least some energy coverage is missing. Off-grid exclusions, source changes, imports, restarts and unknown continuity are not bridged. Negative counter deltas and implausibly large jumps are rejected. Missing channels are independent: both directional counters are required for grid or battery recovery.

The correction replaces the previously integrated share of that counter interval with its counter delta. Adding the whole delta on top of already sampled energy would double-count it, so the already integrated contribution is explicitly subtracted. Subsequent normal samples remain unchanged.

Recovered energy is an **estimate**. The counter quantum is 0.01 kWh (10 Wh), channels are read sequentially, and device update cadence/AC–DC boundaries still need verification. The two-second limit bounds the client collection window; it is not a guarantee about the physical timestamp or internal refresh of a counter. Net ESS energy is derived from the charge-minus-discharge counters. Source reset/reference acknowledgements establish new anchors and never supply energy across the transition.

Original `gridWh`, `essWh`, `pvWh`, sample counts, sums, min/max and `fieldCoverageMs` stay intact. Corrections and recovered duration are stored separately under each quarter's `counterRecovery`. The energy projection adds these estimates only for consumers that explicitly request `getEnergySlots()`. Grid demand estimates, energy-history totals, readiness and indicative replay use this projection; raw power charts and raw daily aggregates remain sampled data. Reports expose how many quarters contain counter estimates. Existing model confirmations and read-only/indicative restrictions remain in force.

Counter anchors and the short interval ledger are deliberately not persisted. An update, abrupt termination, connection change or import therefore prevents recovery across that boundary. Already committed corrections survive ordinary updates. This cannot recover old unobserved quarters merely from the latest lifetime total, nor assign a counter delta across multiple quarters.

## Tibber hourly recovery

The existing historical-price requests now also retain validated import/export volumes independently of whether unit prices have arrived. Both directions keep their original **HOURLY** resolution, source binding and timestamp. Explicit zero is valid; missing values are not zero. Partial replies retain previously reported volumes, corrections replace the corresponding direction, and failed or differently bound fetches cannot replace the usable cache. Existing price-only successful caches are upgraded at the first scheduled attempt; failures and rate-limit backoff remain respected.

For observed hourly energy/cost comparison, four complete Sigenergy energy quarters take precedence. If an hour is incomplete, both Tibber import and export volumes can fill that whole hour instead, labelled `tibber-meter-hourly`. Values from the two sources are not added or mixed within the hour. The selected meter must be confirmed to match the plant. The app's requested window begins with retained raw history, including its incomplete first hours, up to 32 days; it no longer waits for complete inverter energy before requesting that history.

This improves the observed hourly underlay and does **not** fabricate inverter quarters, PV, battery dispatch, SoC or a quarter-hour household-load profile. Battery/solar scenario readiness still needs its own complete quarter inputs. The existing separate monthly Tibber demand reference remains separate. Meter and inverter accounting boundaries can differ, so observed source changes are shown explicitly and never unlock automatic control, validated savings or model ranking.

## Inspection, persistence and backup

**Data och backup → Mätluckor och händelser** retains the raw missing-period report and adds the count of counter-recovered quarters, complete projected grid quarters, and hourly gaps filled by Tibber. **Ekonomisk jämförelse** shows the hourly sources used. Reading either view performs no repair writes or provider fetch.

History writes still commit one bounded canonical snapshot. Recovery remains pending if persistence fails, retries without double-counting, and logs success only after the snapshot is committed. A recovery bookkeeping failure cannot invalidate otherwise usable native Homey Energy counters.

History export **version 7** preserves the separate correction metadata; stored snapshot schema 3 and quarter schema 2 are unchanged. Versions 1–6 remain accepted without adding absent recovery data, and metadata cannot be smuggled into an older export version. Retain a pre-upgrade backup for downgrade: older versions cannot restore version-7 files. Current overlapping history still wins during import. Raw daily summaries keep their original sampled interpretation.

Tibber hourly volumes share the existing bounded historical-price cache (at most 768 hours/2 MiB), remain outside the existing history export, and are fetched again when due. No token or home ID is included in the new diagnostic projection. Synthetic tests cover replay eligibility/provenance, partial channels, negative/positive flow crossings, duplicate/out-of-order observations, resets, bounds, failed writes/retries, backup validation and source/price-independent Tibber volumes. Physical counter timing, energy-boundary agreement and hardware recovery remain installation verification work.
