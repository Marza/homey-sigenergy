# Solar surplus preview

The settings page's **Solöverskott – förhandsvisning utan styrning** section offers a short, read-only scenario for additional charging of the home battery and/or a connected EV, with the remainder exported. It is independent of the deadline-based Tibber charging plan and does not execute either plan. Select **home first** or **EV first** explicitly; these are user priorities, not economic rankings. No import/export price, tariff saving or future production forecast is inferred.

## Source and surplus boundary

Authenticated `POST /solar/preview` reads the existing paired plant's cached power snapshot and existing backup advisory. It opens no connection and performs no Modbus read, settings/store write or hardware command. Exactly one fresh parent is required. Its selected own/third-party/combined `pvW`, signed net `gridW` (positive import), signed `essW` (positive charging), home SoC and, when home allocation is enabled, capacity are used. `capacityKWh` is now carried in the shared snapshot from the already-existing capacity read; no new register read is added. No identifiers, connection settings or credentials are returned.

Available additional solar power is conservatively:

```
exportKW = max(0, -gridW / 1000)
batteryDischargeKW = max(0, -essW / 1000)
availableSolarKW = min(pvW / 1000, max(0, exportKW - batteryDischargeKW))
```

The grid measurement already reflects household consumption and ongoing charging. Those loads are not subtracted twice, and existing charging power is not added back to this incremental budget. All observed home-battery discharge is subtracted from export, even if some discharge is serving local loads; this can underestimate the available solar component. No new house-consumption meter or calibrated whole-house load is synthesized. AC/DC conversion boundaries, sequential sampling, losses and source measurement accuracy still require verification under #37.

The export allocation covers only the remaining **solar budget**, not total grid export. The excluded export component is shown separately. Grid import, zero PV and export supplied entirely by battery discharge produce no extra solar allocation. Missing, negative/invalid solar, stale/future readings, ambiguous parents, off-grid/unknown grid or restricted backup state withhold allocations instead of creating zero readings.

## Inputs and calculation

Choose a 1–15 minute scenario (the form starts at five minutes), assuming the observed flows and current charging remain constant for that period. This is an energy illustration, not an estimate of what the sun or household will actually do.

- **Home battery:** optional explicit target SoC, total maximum charging kW and one-way charging efficiency. Live SoC/capacity are used. Existing positive battery charging consumes both the total power limit and the target's energy room over the entire scenario. An observed discharging home battery receives no extra charging allocation: this incremental scenario preserves existing discharge and must not claim simultaneous storage. Optional BMS limits are not automatically substituted; the input is an assumed limit, not enforced hardware capability.
- **EV:** optional explicit connection, manually read SoC/time, target SoC, ongoing charging kW, minimum sustainable total charging kW and total maximum charging kW. SoC/time must be strictly younger than 15 minutes with an explicit timezone and cannot be future-dated. Current EV power is a manual observation, not verified EVDC telemetry. Saved usable EV capacity, one-way charging efficiency and maximum charging power bound the scenario. The page identifies those saved assumptions; save changes in the charging settings before recalculating.
- In priority order, extra charging is capped by remaining surplus, total power minus ongoing charging, and remaining target energy minus the assumed ongoing charge over the scenario. EV charging is skipped if the available extra power cannot bring total charging to its entered minimum; the next destination can still receive the budget. Existing charging is not stopped or reduced, even if it would itself exceed a target. Manual SoC is treated as the scenario's initial estimate; no earlier driving/charging is reconstructed.
- Output distinguishes additional input kW/kWh from stored kWh after the entered efficiency. The remainder of the solar budget is exported. Values are rounded to six decimals; no currency amount is calculated.

There is no per-phase/fuse enforcement, charging step/phase-switching model, driving, network protection, weather forecast or coupled future dispatch. The separate economic allocator's illustrative efficiency curves are not silently reused. These constraints must be established separately before operational control could be considered.

## Freshness and UI behavior

A preview expires at the earliest of source freshness, 30 seconds after calculation and manual EV SoC expiry. While displayed, the page re-runs the authenticated cached calculation every ten seconds, incorporating current source/configuration/backup state. Input edits, failed/timed-out requests, restricted/missing sources and expiration clear allocations. Late replies cannot restore an obsolete result. An error or edit stops automatic refresh until the user recalculates. Neither form inputs nor results are persisted.

## Validation

Synthetic unit/API/UI fixtures cover signed power and battery-export exclusion, zero/missing/stale/ambiguous sources, both priorities, current-charge reservation, target/capacity limits, EV minimums, manual-data expiry, no-price operation, input validation, no writes, refresh, timeout and late-reply invalidation. Packaged checks include the authenticated route and browser/backend modules. Software tests and package checks do not establish physical calibration or native Homey client behavior. No private household readings or installation observations belong in these fixtures.
