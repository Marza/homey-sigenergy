# Tibber consumption comparison reference

The [official Tibber schema](https://developer.tibber.com/api/reference.md) exposes `consumption` with hourly intervals (`from`, `to`, `consumption`, `consumptionUnit`). The documented hourly page limit is 744; larger windows require pagination. It is not a real-time feed. The app does not assume that missing or not-yet-finalized values mean zero.

## Data model and calculation

`lib/pricing/consumption-history.js` validates a separate bounded `tibberConsumptionHistory` app setting: schema 1, source `tibber-consumption`, resolution `HOURLY`, request bounds/fetch time, a private configuration revision and up to 768 real hours (`t`, `importWh`). Each interval must last exactly one elapsed hour, have a nonnegative finite kWh value and match the request window. Zero is accepted; null consumption remains missing. Invalid units/timestamps, duplicate conflicts and unknown stored fields are rejected. The manual merge helper is idempotent and rejects conflicting existing values; automatic refresh instead replaces a fully validated current-month snapshot to accept upstream corrections.

The source revision binds the reference to the Tibber configuration. A credential/home configuration change hides the old reference until a successful fetch under the new configuration. Imported household time series, source binding and credentials are not exposed by the Dashboard snapshot; only a matching summary is projected.

The demand calculator accepts these **real hourly inputs directly**. It does not divide them into fabricated quarters or add SoC/ESS/PV fields. The same configured Stockholm tariff window, season, holidays, distinct-day peak selection, mean/rate and monthly coverage rules are applied. The separate result identifies `measurementBasis: "tibber-meter-import"`. This is Tibber-reported consumption treated as imported energy for an advisory reference, not an independent determination of meter settlement, estimation status or invoice correctness.

`meterDemandEstimate` is shown separately from the inverter-net estimate. The latter, its raw history, daily summaries and battery scenario results are not replaced or blended with the imported source. Historical meter consumption may already reflect actual battery dispatch. Missing historical ESS energy and SoC prevent reconstructing an unshaved household load or a different battery strategy. Therefore no counterfactual battery savings are calculated from these hours, and no ESS values are filled with zero.

Coverage counts eligible observed hours, elapsed gaps and remaining month hours. A sufficient number of peaks remains **provisional**, including when historical input coverage is complete: future peaks, later provider corrections, contract details and meter/billing comparison remain outside this import.

## One-off operation recorded on 2026-11-13

A user-authorized request fetched the selected home's current-November consumption using the existing saved token. Of 310 returned hourly intervals, **288 contained usable kWh values covering 1–12 November in Europe/Stockholm**; 22 unavailable values stayed absent. All 288 source hours were validated, stored separately on Homey and read back successfully. All **36 previously closed Sigenergy quarters** checked at import time were preserved. No hardware writes, configuration edits or synthetic quarters were performed.

With the installation's configured seasonal/holiday tariff, 117 imported hours were eligible; 13 elapsed eligible hours remained missing. This is a partial current-month reference, not a complete bill or a claim that every hour since installation has settled in Tibber. No raw household values, identifiers, credentials or addresses are published here.

The import also staged a separate validated demand-summary setting. The previously installed **v0.17.9** does not render this new reference; the code in the accompanying PR adds that consumer. The charging-preview PR #29 is independent and was not included in the backfill working copy. No unreviewed runtime update was installed to perform the data import.

## Storage and backup boundary

The original import was administrator-mediated. Automatic daily fetching now maintains the current-month reference; no public import endpoint is added. For the original one-off import, the fetched payload and pre-import state were copied to a private local directory with owner-only permissions before writing. The setting persists with ordinary app updates that preserve app data; it is subject to Homey's app-settings/uninstall behavior.

The existing schema-3 history export/restore covers the original `HistoryStore` only. It **does not include or restore** this separate consumption-reference setting. Keep a separate private copy before uninstalling or migrating the app. No history schema migration or claim of complete backup coverage is introduced.

Tests use synthetic data for null/zero values, malformed intervals/units, duplicate conflicts, idempotent merging, repeated DST hours, direct hourly peak arithmetic, runtime configuration binding and summary-only widget projection. Passing them does not establish billing accuracy or historical battery behavior. Keep issue #7 open for the remaining tariff/meter/invoice evidence.

## Automatic fetching

With a saved Tibber token and an unambiguous home selection, a five-minute scheduler checks whether fetching is due. The first eligible check runs within five minutes after app startup. One successful fetch per **Europe/Stockholm calendar day** is persisted across restarts; failures retry no sooner than one hour later. A new credential/home revision becomes eligible on the next check. No Pulse/live subscription or separate Sigenergy integration is needed for this reference.

Each fetch re-reads the entire elapsed current Stockholm month, using completed hourly boundaries and requests capped at Tibber's 744-hour limit. The backend selects exactly one accessible home (an explicit home ID is required for multiple homes), validates timestamps, units, duplicates and values, and replaces the separate current-month snapshot only after all requests validate. Unlike the original merge-only manual import, these automatic snapshots intentionally accept upstream revisions/corrections. Unavailable/null values remain missing; a previously available value returned as null is no longer used in the new snapshot. A network/validation failure keeps the last successful snapshot and records a safe error status, without storing arbitrary upstream messages. Credential changes and shutdown invalidate in-flight results.

The widget shows the fetch timestamp and a failed-refresh indication alongside usable cached data. The reference still uses the configured tariff and remains provisional, with explicit coverage gaps. It is **not a battery savings estimate or an invoice guarantee**. No inverter quarters, PV/ESS/SoC, settings controlling devices or battery replay data are backfilled or modified.

The first local hour of a new month contains no completed interval; the scheduler waits and retries after an hour. At month rollover, the next valid snapshot replaces the previous month's reference. Previous months are not archived or finalized by this feature. Tibber can publish values later than the daily fetch; they are reconsidered on subsequent days while the month remains current. This is historical consumption, not real-time telemetry ([official Tibber schema](https://developer.tibber.com/api/reference.md)).

The separate reference and sync settings are excluded from the existing HistoryStore export/restore; app-data-preserving updates keep them, but uninstall/migration requires a separate private backup. Automated fixtures cover scheduling/restart/retry, missing and corrected values, DST/month rollover, home selection, malformed responses, credential races and shutdown. Physical automatic fetching with this implementation still requires post-release verification.
