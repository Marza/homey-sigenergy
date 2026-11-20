# Energy-gap recovery

Recovery runs automatically with the existing opt-in **Sigenergy V2.9 energy-counter profile** and the confirmed existing Tibber connection. It adds no Modbus writes, credentials, additional device or additional counter polling. Power-only installations continue collecting power without counter recovery.

## Small Sigenergy gaps

The existing once-per-minute cumulative-energy probe can supply separate grid import/export, battery charge/discharge and the selected own/third-party/combined solar channel. The collector retains a short in-memory ledger of the actual power intervals between counter observations.

A counter pair can estimate missing energy only when:

- Both observations have valid nondecreasing counters and the same connection/profile/source/reference generation.
- The observations are at most **five minutes apart**, within one quarter or spanning one UTC quarter boundary. Boundary-adjacent endpoint probes are deferred until a later safe probe; the original five-minute limit still applies. A reset, source change or implausible jump observed by a deferred probe invalidates the held anchor.
- The entire current polling/collection window is at most **two seconds**, and the power-interval ledger accounts for the complete counter interval.
- At least some energy coverage is missing. Off-grid exclusions, source changes, imports, restarts and unknown continuity are not bridged. Negative counter deltas and implausibly large jumps are rejected. Missing channels are independent: both directional counters are required for grid or battery recovery.

The correction replaces the previously integrated share of that counter interval with its counter delta. Adding the whole delta on top of already sampled energy would double-count it, so the already integrated contribution is explicitly subtracted. Subsequent normal samples remain unchanged.

Recovered energy is an **estimate**. The counter quantum is 0.01 kWh (10 Wh), channels are read sequentially, and device update cadence/AC–DC boundaries still need verification. The two-second limit bounds the client collection window; it is not a guarantee about the physical timestamp or internal refresh of a counter. Net ESS energy is derived from the charge-minus-discharge counters. Source reset/reference acknowledgements establish new anchors and never supply energy across the transition.

Original `gridWh`, `essWh`, `pvWh`, sample counts, sums, min/max and `fieldCoverageMs` stay intact. Corrections and recovered duration are stored separately under each quarter's `counterRecovery`. The energy projection adds these estimates only for consumers that explicitly request `getEnergySlots()`. Grid demand estimates, energy-history totals, readiness, indicative replay, recommendations and the settings simulator use the shared energy projection. Full synchronized grid or ESS meters take precedence where the original channel also has full raw coverage; raw power charts and raw daily aggregates remain sampled data. Reports expose how many quarters contain counter estimates. Existing model confirmations and read-only/indicative restrictions remain in force.

Counter anchors and the short interval ledger are deliberately not persisted. An update, abrupt termination, connection change or import therefore prevents recovery across that boundary. Already committed corrections survive ordinary updates. This cannot recover old unobserved quarters merely from the latest lifetime total, nor recover an exact quarter profile from a lifetime total.

### Allocation across one quarter boundary

A counter delta does not reveal which side of a boundary consumed the energy. For an eligible interval, recovery subtracts all already integrated directional energy first, then distributes only the remaining energy **in proportion to each quarter's missing duration**. This assumes equal average power during the missing portions. Fully observed portions receive no added energy. The final share is calculated as a remainder, so the shares conserve the original residual without per-quarter rounding. For example, a 90 Wh residual with 30 and 60 seconds missing is allocated as 30 and 60 Wh. This is an estimate, not a recovered measurement of the actual quarter profile.

Cross-quarter recovery requires an ordered, gap-free and non-overlapping interval ledger. Negative missing import/export, negative missing solar production, or an implausible residual are not spread across quarters; quantization or disagreement with the sampled share leaves the gap unknown. Charge and discharge counters remain independently nondecreasing; their residuals must both be nonnegative before net battery energy is allocated. Combined solar retains the component-reset checks.

All affected quarters for a channel are validated together and included in one canonical history write. A missing, full, overlapping or invalid target rejects the entire channel's batch. Write failures retain the batch for retry; successful retries do not add energy again. Independent valid channels can still recover. Each affected row stores bounded `counterRecovery[channel].parts` with the source interval, both missing durations, residual energy and `missing-time-proportional` method. Per-quarter aggregates must equal the sum of their non-overlapping parts. Existing ordinary corrections can coexist with these parts. No connection IDs, credentials, power peaks or SoC samples are added.

Diagnostics separately count quarters containing a boundary allocation and explain that the exact distribution remains unknown. Raw observations and daily aggregates remain unchanged. Partial rows containing only an anchor contribute zero observed time; validated recovered duration is still visible. Indicative replay retains its existing counter-estimate provenance and read-only restrictions. This feature does not establish the actual demand peak, savings or control readiness.

## Tibber hourly recovery

The existing historical-price requests now also retain validated import/export volumes independently of whether unit prices have arrived. Both directions keep their original **HOURLY** resolution, source binding and timestamp. Explicit zero is valid; missing values are not zero. Partial replies retain previously reported volumes, corrections replace the corresponding direction, and failed or differently bound fetches cannot replace the usable cache. Existing price-only successful caches are upgraded at the first scheduled attempt; failures and rate-limit backoff remain respected.

For observed hourly energy/cost comparison, four complete Sigenergy energy quarters take precedence. If an hour is incomplete, both Tibber import and export volumes can fill that whole hour instead, labelled `tibber-meter-hourly`. Values from the two sources are not added or mixed within the hour. The selected meter must be confirmed to match the plant. The app's requested window begins with retained raw history, including its incomplete first hours, up to 32 days; it no longer waits for complete inverter energy before requesting that history.

This improves the observed hourly underlay and does **not** fabricate inverter quarters, PV, battery dispatch, SoC or a quarter-hour household-load profile. Battery/solar scenario readiness still needs its own complete quarter inputs. The existing separate monthly Tibber demand reference remains separate. Meter and inverter accounting boundaries can differ, so observed source changes are shown explicitly and never unlock automatic control, validated savings or model ranking.

## Inspection, persistence and backup

**Data och backup → Mätluckor och händelser** retains the raw missing-period report and adds the count of counter-recovered quarters, complete projected grid quarters, and hourly gaps filled by Tibber. **Ekonomisk jämförelse** shows the hourly sources used. Reading either view performs no repair writes or provider fetch.

History writes still commit one bounded canonical snapshot. Recovery remains pending if persistence fails, retries without double-counting, and logs success only after the snapshot is committed. A recovery bookkeeping failure cannot invalidate otherwise usable native Homey Energy counters.

History export **version 8** preserves the partitioned allocation evidence; stored snapshot schema 3 and quarter schema 2 are unchanged. Versions 1–7 remain accepted; ordinary version-7 corrections are unchanged and no absent coverage is invented. Partitioned metadata cannot be smuggled into a version-7 or older file. Retain a pre-upgrade backup for downgrade: older versions cannot restore version-8 files. Each quarter carries its own validated share and source interval, so a retention boundary or partial import retains that share rather than attributing the entire counter delta to the surviving quarter. Current overlapping history still wins during import. Raw daily summaries keep their original sampled interpretation.

Tibber hourly volumes share the existing bounded historical-price cache (at most 768 hours/2 MiB), remain outside the existing history export, and are fetched again when due. No token or home ID is included in the new diagnostic projection. Synthetic tests cover replay eligibility/provenance, partial channels, negative/positive flow crossings, duplicate/out-of-order observations, resets, bounds, failed writes/retries, backup validation and source/price-independent Tibber volumes. Physical counter timing, energy-boundary agreement and hardware recovery remain installation verification work.
