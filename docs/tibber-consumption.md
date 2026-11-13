# One-off Tibber consumption reference

The [official Tibber schema](https://developer.tibber.com/api/reference.md) exposes `consumption` with hourly intervals (`from`, `to`, `consumption`, `consumptionUnit`). The documented hourly page limit is 744; larger windows require pagination. It is not a real-time feed. The app does not assume that missing or not-yet-finalized values mean zero.

## Data model and calculation

`lib/pricing/consumption-history.js` validates a separate bounded `tibberConsumptionHistory` app setting: schema 1, source `tibber-consumption`, resolution `HOURLY`, request bounds/fetch time, a private configuration revision and up to 768 real hours (`t`, `importWh`). Each interval must last exactly one elapsed hour, have a nonnegative finite kWh value and match the request window. Zero is accepted; null consumption remains missing. Invalid units/timestamps, duplicate conflicts and unknown stored fields are rejected. Identical imports are idempotent and existing values are never silently replaced.

The source revision binds the reference to the Tibber configuration. A credential/home configuration change hides the old reference until explicitly revalidated. Imported household time series, source binding and credentials are not exposed by the Dashboard snapshot; only a matching summary is projected.

The demand calculator accepts these **real hourly inputs directly**. It does not divide them into fabricated quarters or add SoC/ESS/PV fields. The same configured Stockholm tariff window, season, holidays, distinct-day peak selection, mean/rate and monthly coverage rules are applied. The separate result identifies `measurementBasis: "tibber-meter-import"`. This is Tibber-reported consumption treated as imported energy for an advisory reference, not an independent determination of meter settlement, estimation status or invoice correctness.

`meterDemandEstimate` is shown separately from the inverter-net estimate. The latter, its raw history, daily summaries and battery scenario results are not replaced or blended with the imported source. Historical meter consumption may already reflect actual battery dispatch. Missing historical ESS energy and SoC prevent reconstructing an unshaved household load or a different battery strategy. Therefore no counterfactual battery savings are calculated from these hours, and no ESS values are filled with zero.

Coverage counts eligible observed hours, elapsed gaps and remaining month hours. A sufficient number of peaks remains **provisional**, including when historical input coverage is complete: future peaks, later provider corrections, contract details and meter/billing comparison remain outside this import.

## One-off operation recorded on 2026-11-13

A user-authorized request fetched the selected home's current-November consumption using the existing saved token. Of 310 returned hourly intervals, **288 contained usable kWh values covering 1–12 November in Europe/Stockholm**; 22 unavailable values stayed absent. All 288 source hours were validated, stored separately on Homey and read back successfully. All **36 previously closed Sigenergy quarters** checked at import time were preserved. No hardware writes, configuration edits or synthetic quarters were performed.

With the installation's configured seasonal/holiday tariff, 117 imported hours were eligible; 13 elapsed eligible hours remained missing. This is a partial current-month reference, not a complete bill or a claim that every hour since installation has settled in Tibber. No raw household values, identifiers, credentials or addresses are published here.

The import also staged a separate validated demand-summary setting. The previously installed **v0.17.9** does not render this new reference; the code in the accompanying PR adds that consumer. The charging-preview PR #29 is independent and was not included in the backfill working copy. No unreviewed runtime update was installed to perform the data import.

## Storage and backup boundary

This is an administrator-mediated, one-off data import; no automatic consumption polling or public import endpoint is added. The fetched payload and pre-import state were copied to a private local directory with owner-only permissions before writing. The setting persists with ordinary app updates that preserve app data; it is subject to Homey's app-settings/uninstall behavior.

The existing schema-3 history export/restore covers the original `HistoryStore` only. It **does not include or restore** this separate consumption-reference setting. Keep a separate private copy before uninstalling or migrating the app. No history schema migration or claim of complete backup coverage is introduced.

Tests use synthetic data for null/zero values, malformed intervals/units, duplicate conflicts, idempotent merging, repeated DST hours, direct hourly peak arithmetic, runtime configuration binding and summary-only widget projection. Passing them does not establish billing accuracy or historical battery behavior. Keep issue #7 open for the remaining tariff/meter/invoice evidence.
