# Sigenergy Local Monitor for Homey

Experimental Homey SDK v3 app for local, read-only Sigenergy monitoring, Nibe SMO S40 temperature readings and an optional island-mode production block, and advisory energy planning.

**Version 0.17.0 · Advisory energy planning · MIT licensed**

The project targets a Homey Pro 2023 and SigenStor EC 17.0 TP setup. **Basic installation, pairing, plant readings and recovery after a Homey reboot were tested on one physical Homey Pro running firmware 13.5.4 on 2026-11-13.** The user confirmed the base readings against mySigen with unit ID 247. **Nibe SMO S40 Modbus reads also worked after Modbus was enabled, and the user confirmed all four temperatures against the Nibe display.** See the [verification record](docs/installation-verification.md) for scope and remaining tests. Exact inverter firmware and the full register profile remain unverified; EVDC, optional battery telemetry and island/safety behavior have not been hardware-validated. Unit tests do not establish hardware compatibility or safe operation.

## Features and implementation status

| Area | Implemented in source | Status and limits |
| --- | --- | --- |
| Sigenergy monitoring | Battery SoC and capacity, grid/PV/battery power, grid mode; Homey device capabilities | Local Modbus TCP reads; one plant per Homey through a fixed pairing identity |
| Battery telemetry | Optional power limits, available energy, nominal power, SoC cutoffs and SoH | Probed about every five minutes; individual failures do not invalidate the main snapshot; registers and scaling unverified |
| EVDC monitoring | Optional DC power, vehicle SoC, state, session energy and total counters | Disabled by default; V2.9 profile awaiting hardware verification |
| Phase current | Live L1/L2/L3 readings and quarter-hour averages, peaks and coverage | Configured grid meter at the household connection. |
| EVAC monitoring | Optional AC charging power and cumulative energy consumption | Disabled by default; read-only Modbus, awaiting hardware verification |
| Household load | Quarter-hour energy excluding EV charging on a dedicated counter | Requires the V2.9 statistics profile and plant ID 247; separate coverage in diagnostics |
| Nibe monitoring | SMO S40 outdoor, hot-water, supply and return temperatures | Four readings verified against the display on one installation; optional local reads once per minute, optional production block described below |
| Backup advisory | Grid/island/unknown state and a “Backup mode changed” Flow trigger | EV-stop and Nibe-mode tokens are requests, never confirmation of an action |
| Native Homey Energy | Optional grid, solar and battery power-reporting companions | W/% plus opt-in V2.9 cumulative kWh profile; physical counter/history verification pending |
| Local history | Quarter-hour aggregates, daily summaries, backup-mode events and JSON export | Stored in Homey app settings, not a dedicated database |
| Tibber prices | Cached prices and historical meter references | Price coverage and timestamps are shown separately |
| Household forecast | Next 24 hours of general household demand excluding EV charging | Based on locally measured quarters, with forecast coverage and observed errors |
| Demand charges | Configurable hourly peak selection and provisional monthly fees | Provisional; dated Telge rules documented, billing comparison pending |
| Dashboard | Energy overview, historical energy flows, and five-minute power history | Uses local saved data with explicit measurement coverage |
| Marginal energy costs | Separate import/export, tax, grid-fee and battery-wear calculations | Standalone tested module; not connected to production prices, Dashboard or runtime scenario ranking |

The app settings page is primarily Swedish. It includes **Översikt** (overview), **Elpriser** (prices), **Historik** (history), **Prognos** (household forecast), **Diagnostik** (diagnostics) and **Inställningar** (settings).

## Monitoring and optional Nibe outage control

Battery, inverter and EV monitoring and energy planning are read-only. The only hardware write is a separately enabled SMO S40 Modbus AUX block. Enable it in **Inställningar → Anslutningar → Nibe SMO S40** after confirming the pump configuration and reserving Modbus AUX for Homey. **Diagnostik → Nibe vid ödrift** shows the latest check. See [configuration, recovery and register sources](docs/backup-advisory.md#nibe-production-block).

Backup logic interprets input register 30009 as 0 = grid, 1/2 = island, anything else = unknown. Grid restoration requires five minutes of successful grid readings, including after app startup. Communication failure returns the advisory state to unknown. Island or unknown state requests EV stop and a restricted Nibe mode; below 25% battery SoC it requests critical mode. The Flow tokens are advisory. The independent Nibe production block requires five minutes of continuously observed island operation. Verify the register mapping against your firmware.

Homey polling is not fuse protection, load balancing or an outage fail-safe. Keep native inverter/charger protections and Nibe frost protection and existing local schedules active. Do not switch heat-pump mains with a smart relay as a substitute for a validated control interface. Homey and networking must remain powered for monitoring during an outage.

## Prerequisites

- A local Homey installation. The manifest declares SDK 3, local platform only and Homey firmware `>=12.4.5`; this is a declared minimum, not a tested compatibility matrix.
- Sigenergy reachable from Homey over the LAN, with Modbus TCP read access enabled in mySigen and permitted by firmware/network configuration.
- Verified register addresses, widths, scaling, word order and address-offset convention for your hardware. The current Sigenergy map derives from an [unofficial V2.5 protocol transcription](https://github.com/krzychdre/modbus-sigenergy/blob/main/Sigenergy_Modbus_Protocol_V2.5.md).
- Git, Node.js and npm on the development computer. Use Node.js 24 (the CI version) and npm. The project requires Node.js 24+ and pins Homey CLI 4.6.3 in its development dependencies. Follow the [official setup requirements](https://apps.developer.homey.app/the-basics/getting-started) for Docker and local execution.
- Optional: a Tibber API token/subscription with consumption prices, or a Nibe SMO S40 with Modbus TCP/IP enabled and its own register export checked.

## Downloadable releases

Successful CI runs on `main` publish a versioned production archive and SHA-256 checksum in [GitHub Releases](https://github.com/Marza/homey-sigenergy/releases). Follow the [release installation instructions](docs/release-installation.md) to install or update through Homey CLI. A computer and Homey login are required. Releases are local developer installations, not App Store packages.

## Local installation with Homey SDK v3

This is a source-based development installation. One physical Homey Pro installation on firmware 13.5.4 has passed basic pairing, plant monitoring and post-reboot recovery; see the [verification record](docs/installation-verification.md). Other configurations and uninstall/reinstall behavior remain untested.

```sh
git clone https://github.com/Marza/homey-sigenergy.git
cd homey-sigenergy
npm ci
npm test
npm run validate
npm run build:homey
npx --no-install homey login
npx --no-install homey select
npx --no-install homey app run
```

Use a development computer on the same network as Homey and start Docker when required by the CLI. Select your intended Homey when prompted. `homey app run` provides development logging; stopping it removes that development instance. To install without keeping the terminal session open, use:

```sh
npx --no-install homey app install
```

See the [official Homey CLI reference](https://apps.developer.homey.app/the-basics/getting-started/homey-cli) for validation, runtime options and troubleshooting. The commands above use the repository's locked CLI; a global installation is unnecessary. Validation uses the `debug` level for local development, not App Store certification. Native Energy counter mappings raise the app minimum to Homey 12.4.5; the declared minimum is not proof of physical compatibility. See [installation verification](docs/installation-verification.md) for observed results and the pending hardware checklist.

Pair **Sigenergy plant**, then open the device's advanced settings and replace the example host before relying on readings. Pairing does not discover an inverter; it returns one fixed plant identity.

## Configuration

### Sigenergy device settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `host` | `192.168.1.100` | Example only; replace with the inverter LAN address |
| `port` | `502` | Modbus TCP port |
| `unitId` | `247` | Plant unit ID |
| `addressOffset` | `0` | Register address adjustment; use -1 only if verified necessary |
| `pollSeconds` | `10` | Main polling interval, clamped to at least five seconds |
| `evdcEnabled` | `false` | Enable read-only EVDC telemetry for supported V2.9 firmware |
| `evdcUnitId` | `0` (unset) | Modbus ID (1–246) of the inverter hosting the DC charger, as configured in mySigen |
| `evacEnabled` | `false` | Enable read-only EVAC telemetry |
| `evacHost` | Empty | AC charger LAN address. If empty, use the plant Modbus endpoint |
| `evacUnitId` | `0` (unset) | AC charger Modbus ID (1–246), as configured in mySigen |

Compare SoC, capacity, grid power and PV power against mySigen. The code assumes **positive grid power = import**, negative = export; **positive battery power = charging**, negative = discharging.

To collect EVDC data, enter the inverter ID in the Sigenergy device’s advanced settings and enable EVDC. Keep the plant unit ID at 247. The fixed profile reads signed power in W (`31502`), vehicle SoC in tenths of a percent (`31504`), session charging energy (`31505`), running state (`31513`) and total charge/discharge energy (`31519`/`31521`). Energy registers are in hundredths of a kWh. See [Sigenergy Modbus Protocol V2.9, Table 5-3](https://github.com/ks00410/sigenergy-modbus-profile/blob/main/references/Sigenergy%20Modbus%20Protocol%202026-05-13%20V2.9.pdf). The older experimental settings for register addresses and divisors are no longer used.

Check **Diagnostik** during idle and active charging and compare the power, SoC and session energy against mySigen. Power is integrated into quarter-hour DC energy with its own measured coverage. A missing reading breaks the EVDC interval even when the other plant data is available. The session and total counters are displayed as current readings. The lifetime charge and discharge counters can recover eligible missing energy between two readings.

At the default ten-second interval, the plant and gateway diagnostics share one read of 30004–30009 on unit 247 for grid-sensor status, signed grid power and grid mode. The result is used only for that poll. If the shared block is unavailable or the polls run independently, the plant reads 30005–30009. Own PV and battery power are read together (30035–30038). Third-party solar uses its separate register on each poll when selected. Battery SoC and capacity are sampled once per minute at the default cadence. Every five minutes, three blocks supply the nine optional battery diagnostics. A device that rejects a block with an illegal address or value falls back to individual registers for that block until the reader restarts.

The app saves local meter checkpoints together with the energy history. Matching grid, selected solar, battery, enabled AC and DC charger, and household meters can bridge up to **15 minutes between trusted readings**, including an app restart. Five-minute and quarter estimates use the time missing in each interval. **Data och backup** shows observed, estimated and unknown time separately. A meter reset, changed source or longer outage starts a new interval. [Energy-gap recovery](docs/gap-recovery.md).

### Phase current and the main fuse

**Grid phases.** In the Sigenergy device's advanced settings, **Mätkälla för nätfaser** defaults to the configured SDM630 if it has an address, otherwise the Sigenergy Gateway. Selecting **Gateway** uses the plant host, port and address offset with unit 247. Every ten seconds, the app checks grid-sensor status (30004) and reads L1/L2/L3 voltage and current (30286–30297), and signed active and reactive power (30052–30063). The 20 November 2025 V2.8 map lists these voltage registers. V2.9 assigns 30286 to battery temperature. The app rejects incompatible voltage blocks and leaves the voltage graph empty on affected firmware. Only grid-side currents are recorded. An existing SDM630 can continue supplying grid current using its configured host, port and ID.

Open **Diagnostik → Nätets senaste 24 timmar** for minimum, mean and maximum per five-minute interval. Select a quantity and phase, or expand the timestamped table for sample counts. Raw ten-second samples are retained locally for a rolling 24 hours in hourly partitions, checkpointed every minute and on graceful shutdown. Missing readings contribute no samples. The existing longer-term quarter-hour grid current summaries continue separately.

**Investigating island operation.** Diagnostics lists the most recent observed changes in plant grid mode (30009: on-grid, automatic or manual island operation) and grid-related alarm flags (30027, merged PCS Alarm1 bits 9–14), with Stockholm timestamps. A gap starts a new observation period. The sampled alarms can help correlate an incident with a reported outage, voltage imbalance, under/overvoltage or under/overfrequency. Ten-second polling can miss a brief disturbance. The public local register maps used here do not identify an actual frequency measurement from the Gateway's utility side. Register 30276 is the rated frequency, and 31002 measures at the inverter. See Sigenergy’s [V2.8 grid-sensor registers, Table 5-1](https://github.com/user-attachments/files/23870043/Sigenergy.Modbus.Protocol.EN.-.v2.8.-.2025-11-20.pdf) and [V2.9 inverter registers, Table 5-3](https://github.com/ks00410/sigenergy-modbus-profile/blob/main/references/Sigenergy%20Modbus%20Protocol%202026-05-13%20V2.9.pdf).

Under **Hushåll**, the saved main fuse and total import limit describe the grid connection. The forecast estimates household demand independently of those limits.

For a Sigen EV AC charger (EVAC), enable EVAC and enter its own Modbus ID in the Sigenergy device’s advanced settings. Enter the charger’s LAN IP for a direct connection on port 502. Leave it empty if the existing plant endpoint can route requests to that unit ID. The read-only profile uses `32000` (state), `32001` (total consumed energy in 0.01 kWh) and `32003` (power in W). Compare the Homey power and total consumption against mySigen. The app stores measured AC charging in its own quarter intervals, uses independent coverage and reports the charger total separately from plant grid import. See [Sigenergy Modbus Protocol V2.9, Table 5-5](https://github.com/ks00410/sigenergy-modbus-profile/blob/main/references/Sigenergy%20Modbus%20Protocol%202026-05-13%20V2.9.pdf).

### App settings

- **Nibe:** Enter host, port (502), unit ID (1) and address offset (0). An empty host disables polling. The profile assumes signed 16-bit input registers divided by 10: 1 = BT1/outdoor, 8 = BT7/hot water, 39 = BT25/supply, 88 = BT71/return. Check these addresses against your SMO S40 register export. Diagnostics shows each sensor separately. Unsupported registers, failed reads and invalid temperatures leave that field unavailable until a successful poll. A connection failure clears current temperatures. The app accepts −50 to 100 °C for outdoor history and −50 to 150 °C for the water sensors as plausibility limits. Only a fresh BT1 measurement enters outdoor history. The runtime does not calculate Nibe tariff windows or replace its local schedule.
- **Household forecast:** Uses the existing general-load history automatically when the V2.9 meter profile supplies complete quarter-hour energy.
- **Tariff:** Enter confirmed contract values as described below. Saving a form does not verify the tariff.

### Tibber prices and pricing caveats

Save the token and, for multiple homes, the exact Tibber Home ID in app settings. The token is stored in Homey settings and used in requests to `https://api.tibber.com/v1-beta/gql`. Price-cache objects and history exports exclude it. Do not share tokens or settings containing credentials.

The runtime fetches on startup and checks eligibility every five minutes. It normally refreshes hourly; after 13:00 Europe/Stockholm it retries at 15-minute intervals until the whole of tomorrow is covered. Missing current prices also select 15-minute retries. Saving credentials makes the next check eligible. Failed requests retain the previous cache and its still-valid, verified intervals; the error is shown separately from price coverage.

The query explicitly requests **quarter-hour consumption** `priceInfo(resolution: QUARTER_HOURLY).today/tomorrow` with `total`, `startsAt` and `currency`. Normalization uses the requested fixed resolution, never stretches a price across missing starts, rejects conflicts/invalid values and accepts negative prices. The app currently accepts SEK only. Identical duplicates are counted once. Tomorrow is complete only with full Stockholm-day coverage (23/24/25 hours); partial publication remains partial. No continuous 48-hour horizon is promised. Older price caches with inferred ends are not used for planning until a fresh validated fetch. See [Tibber contract, fixtures and coverage](docs/tibber-prices.md).

The settings page reports available intervals, gaps, last fetch/attempt/error and earliest refresh eligibility.

The app uses saved contract terms for historical, indicative energy costs. Costs, measured demand peaks and Tibber references remain separate from the household forecast.

## Telge Nät demand-tariff assumptions

This is a configurable estimator, **not a verified implementation of Telge Nät's current contract**. No tariff object or rate is installed by default. The form starts without times, weekdays, peak count, rate, day-selection rule or season assumptions. Holiday exclusions are an explicit opt-in. Existing settings are loaded explicitly. Example tariffs in tests do not establish your contract.

Configure `start`, `end`, `weekdays` (0 = Sunday), `peakCount`, `distinctDays` and `rateSekPerKw` from your confirmed price list. Select active `months` (1–12) or explicitly choose **Hela året** (all year). Existing seasonal selections survive edits; all-year tariffs omit `months`. UI and backend share the same validation: full-hour times within one day, unique valid weekdays/months, an integer peak count of 1–31, a non-negative finite rate and an explicit day-selection rule. Empty fields are not treated as zero or a default contract.

Widget labels follow the configured peak count. Tariff edits refresh the demand estimate immediately. Cached results with a different tariff configuration or calendar month are hidden until recalculated. Months outside the configured season are labelled inactive. These checks establish configuration consistency, not that the tariff matches Telge Nät’s contract.

The estimator:

- Uses Europe/Stockholm calendar dates and full-hour windows within one day.
- Requires four contiguous, aligned quarter-hour energy records per eligible hour, each with at least 14 minutes of coverage.
- Sums signed `gridWh` for the hour, clamps net export to zero, selects the highest configured number of hourly values (optionally from distinct days), and multiplies their mean kW by the configured SEK/kW rate.
- Returns `insufficient-data` until enough eligible peaks exist; otherwise the estimate remains `provisional`.

Select **Telge: svenska helgdagar, julafton och nyårsafton undantas** (`calendar: "se-telge"`) to exclude Swedish public holidays plus Christmas Eve and New Year’s Eve. Omitted `calendar` or `"none"` retains the generic weekday-only calculation; existing tariffs are not silently migrated. The selected calendar is part of result identity, so changing it hides old results until recalculation.

The result includes `coverage`: expected eligible hours in the full Stockholm calendar month, elapsed closed hours, complete observed hours, missing elapsed hours, remaining hours and `complete`/`partial` coverage. Completely absent hours count as missing. Future/open hours cannot qualify. Duplicate quarter records invalidate that hour. Real UTC hours are enumerated separately across DST, then filtered by local dates. The widget shows measured/expected, missing and remaining hours for the estimate. A sufficient set of observed peaks still yields a **provisional estimate for observed hours**, not a complete-month bill.

See [dated Telge rules and validation gaps](docs/telge-tariff.md) for the public 2026 tariff reference, reproducible synthetic example and remaining billing checks. Older records without coverage cannot qualify. The 32-day detailed window can retain the full current calendar month, including a 31-day month with a DST transition; this is a storage bound, not proof that every interval was observed. Verify seasonal rules, import/export treatment, peak selection, VAT basis and rate against your contract.

Automatic daily Tibber consumption fetching supplies a **separate hourly demand reference** for the current Stockholm month, including available hours before app installation. It re-fetches the elapsed current month and the whole previous month to include delayed values and corrections, retaining the current month plus twelve previous months; failed requests retain the previous snapshot and retry after an hour. Fetching uses the saved Tibber token/home selection and starts within five minutes of app startup when due. The widget displays it alongside, rather than merged into, inverter history. Imported hours retain their hourly resolution/source and cannot supply missing local household-load measurements. Missing/delayed Tibber values stay missing. See [hourly consumption reference](docs/tibber-consumption.md) for scope, storage and backup limits.

## Native Homey Energy

Optional **Sigenergy Energy — grid / solar / battery** devices report fresh power from the existing plant reader through standard Homey capabilities. Pair only the sources you need and exclude duplicate P1/Tibber/solar integrations from Energy. Existing plant pairing, settings and history remain intact. The companions reuse the existing reader and add no device commands. Optional cumulative kWh uses a documented Sigenergy V2.9 statistics profile, a single shared, read-only plant counter block on each configured plant poll (10 seconds by default) (with individual-register fallback) and persistent monotonic guards. Enable the profile only after verifying firmware support; it defaults to power-only. Select own PV, third-party PV or their combined kWh source explicitly; changing an established solar source requires a continuity acknowledgement to avoid a lifetime-energy spike. An authenticated cached diagnostic endpoint distinguishes raw source totals from adjusted Energy totals. Existing companions acquire the kWh fields without re-pairing. Native kWh history, source counter agreement and AC measurement boundaries still require physical verification. See [setup, source mapping and physical checklist](docs/homey-energy.md). The custom Dashboard widget is separate.

The V2.9 statistics profile also reads plant register `30228` on each plant poll. In **Diagnostik**, **Husets förbrukning utan billaddning** shows the counter, general load power from register `30282`, the mean power between valid readings and, in the selected gap-report period, the energy and coverage recorded in completed quarters. The counter directly measures common loads according to [Sigenergy Modbus Protocol V2.9, Table 5-1](https://github.com/ks00410/sigenergy-modbus-profile/blob/main/references/Sigenergy%20Modbus%20Protocol%202026-05-13%20V2.9.pdf). After a failed probe the next successful plant poll reads the counters again. Matching household-counter readings up to 15 minutes apart can recover energy across communication failures and app restarts. Diagnostics reports the recovered duration. Resets and longer outages leave gaps. Energy is apportioned by elapsed time when a successful reading pair crosses a quarter, with that allocation marked estimated. The series is separate from native Energy, grid totals.

## Battery and electricity prices

Add **Batteri och elpris** to a Homey Dashboard. Choose today or tomorrow and select a quarter to inspect prices, measured battery SoC and the projected SoC if the proposed trades are followed. Solid turquoise shows observed five-minute averages and the latest reading. Dashed turquoise shows the advisory plan. The window list gives the extra grid purchase or export attributable to the battery.

For each planned quarter, the widget shows expected solar energy and its source. Within the current Stockholm day the plan uses the latest applicable measurement-adjusted forecast. Otherwise it uses the original weather forecast across all configured roofs, including for tomorrow. When a quarter is missing or the weather issue is disabled, superseded by a configuration change or at least two hours old, it uses the median fully covered solar energy at the same local time over the previous seven days. A forecast of zero is valid. EV charging has its own same-time median across enabled chargers. The plan adds EV energy to the household forecast and subtracts solar energy once. Missing required history leaves a gap in the plan.

The existing Tibber request fetches both the subscription total and the Nord Pool spot component in SEK/kWh. The widget applies the published cost contract effective on each Stockholm date. For a spot-based contract, purchase VAT applies to spot plus the saved purchase additions. Estimated sale proceeds use spot plus the saved export benefit less the export fee. This assumes a spot-indexed sale agreement. Older cached prices acquire the spot component on the next successful refresh. [Tibber price fields](https://developer.tibber.com/docs/reference)

Homey computes the battery plan at app startup and once a minute while the app runs, even with all dashboards closed. Each run uses the latest available telemetry, prices and household forecast. All widget instances read the same in-memory report. The widget shows the calculation time. Homey discards the previous report on restart or a calculation error, and suppresses pending trades on a grid restriction.

Planning starts at the next quarter, covers up to 24 hours of contiguous prices and usable forecasts. A dynamic program compares quarter-by-quarter dispatch on a bounded SoC grid aligned to a full charging quarter where practical, including the exact opening level and BMS cutoffs. It accounts for the household forecast, separate quarter-hour estimates for EV charging and solar generation, wear, 95% efficiency per direction, current BMS power limits and the configured household import cap. In active demand-tariff windows it avoids grid charging and first minimizes quarter-average import energy above the household target (default 3 kW, configurable under **Hushåll**). It then minimizes energy cost and wear, preferring fewer grid-charging quarters at equal cost. With a tariff window in the horizon it values a closing energy deficit at the cheapest modeled off-window refill price including charge losses. Without a refill opportunity it favors retaining opening energy after peak protection. Outside tariff-window plans the terminal SoC equals the opening SoC. The widget reports forecast import and any target overrun. The quarterly target is a planning margin for the hourly tariff calculation. If a main fuse is configured, additional grid trades are capped by the spare current on the historically highest-loaded phase at that time, assuming balanced three-phase power at 230 V. Missing matching phase observations allow only actions that do not increase grid import or export. These estimates can change with weather, new EV schedules and phase imbalance. Stale battery data, island mode, missing inputs or infeasible limits restrict the plan. The widget sends no hardware commands.

## History, diagnostics and household forecast

The plant and EVDC readers sample battery and vehicle state of charge on the first available poll of each minute. History stores five-minute mean percentages with sample counts. Nibe reads its four temperatures once per minute and records the outdoor mean and sample count on the same quarter-hour boundaries as household consumption. Missing observations leave partial or empty intervals. The household forecast currently uses consumption history.

History is committed as one bounded snapshot in Homey settings, retaining up to 32 days of quarter-hour records (3,072 slots), 730 Stockholm-calendar daily summaries and 500 events. Each field has independent observation counts and continuity, so optional EVDC samples cannot dilute plant averages or interrupt plant energy integration. Power integration requires valid observations within 1.5 configured poll intervals (15 seconds by default, capped at 60 seconds); short intervals crossing quarter boundaries are split using linear interpolation. Longer power gaps and restarts break power interpolation. Matching energy counters can supply estimates for the missing intervals as described above. New daily summaries use Europe/Stockholm dates with explicit partial/complete coverage; 23- and 25-hour days are handled. Archived day totals are not overwritten by a truncated retained suffix. Older UTC daily summaries are preserved separately.

Quarter-hour records retain schema 2; the canonical snapshot and unified JSON export use schema 3. Older records remain available but are not retroactively repaired, and the UI does not invent per-field means from their shared sample count. If a new sample overlaps an older active quarter, its original data is preserved under `legacy` rather than merged into the new calculations. See [history format and migration](docs/history-format.md) for the record fields and limits.

Export a versioned combined JSON backup manually from app settings. It includes inverter history and retained monthly Tibber references; older history-only exports remain accepted. Export excludes the Tibber token but still contains private usage patterns; keep it private or sanitize it before sharing. The settings page can preview and merge a previous export. Existing intervals win on overlap, so energy is not added twice or overwritten. Legacy exports are validated and accepted; configuration and credentials are never restored. Meter references from a different configuration revision require explicit confirmation that they belong to the currently configured Tibber home. Restore uses separate, retry-safe commits for inverter history and meter references; see [backup format and recovery](docs/history-format.md#combined-backup-and-meter-archive). A 1 MiB meter-archive budget, 4 MiB inverter snapshot budget and 8 MiB input-file limit are application limits, not a claimed Homey capacity guarantee. Full-window storage and restore transport on physical Homey remain to be tested before issue #6 is considered hardware-verified.

Diagnostics use the same source-status rules in the backend, settings and widget: disabled/unconfigured, waiting for data, fresh, partial optional-battery data, stale, or failed. EVDC enablement comes from the actual device configuration, even before its first successful read. Optional battery register errors are shown individually; an entirely failed optional probe is not healthy. Connection refusal, timeouts and unsupported registers have explanatory messages.

The settings page refreshes every 15 seconds and the widget every 30 seconds. Failed, disabled, stale or future-dated sources hide their overview readings and temperature/BMS context. Changing Nibe connection settings clears its old snapshot and ignores in-flight results from the earlier configuration. Re-enabling a source requires a new reading. Sigenergy status expires after at least 30 seconds (or three configured polling intervals), Nibe/EVDC after 90 seconds (EVDC also allows three polling intervals), and optional battery data after ten minutes. These are software freshness limits, not guarantees of sensor accuracy.

The overview and widget use saved quarter-hour averages rather than live device capabilities and label them as history. Historical charts remain available with their timestamps; overview cards clear on missing/failed history or intervals older than 30 minutes. The widget uses its scoped read-only API and is checked in the built app and extracted release archive. Local synthetic light/dark browser previews are available; add/remove and runtime behavior on physical Homey remain unverified. See [Dashboard verification](docs/dashboard-widget.md).

Add **Energiflöden** or **Effekthistorik** from the Sigenergy section of the Homey Dashboard widget picker. Energiflöden sums energy entering and leaving the system for a selected Stockholm day, week or month. It shows each channel's coverage from the retained quarter history (up to 32 days). With V2.9 plant statistics enabled, the default flow view uses changes between synchronized counter reads normally ten seconds apart. Colored bands estimate source-to-load energy for the measured part of the period. The detail view shows coverage, estimated links and unmatched energy. The quarter-history option shows separate side totals and uses each quarter’s net battery and DC energy. House consumption comes from the Sigenergy common-load counter, which excludes EV charging. Effekthistorik plots signed five-minute means in kW from the same power observations. Each series needs full interval coverage. Older quarters retain their original 15-minute resolution. The time selector shows the actual bounds of each point. Both views distinguish measured zeros, missing data and periods with estimated energy. In Effekthistorik, the dashed **Husprognos (15 min)** line shows the existing household forecast excluding EV charging. Each step is a quarter-hour mean on the same kW axis as the house series. Select tomorrow to see the part of the rolling 24-hour forecast beyond midnight. Missing forecast quarters appear as gaps. Forecasts are excluded from measured coverage and energy totals. [How the Dashboard widgets are verified](docs/dashboard-widget.md).

### Household forecast

Open **Prognos** in the app settings. Homey issues 96 predictions, one per real quarter-hour, starting at the next quarter boundary. Training uses only closed, fully covered general-load intervals from register 30228 in the retained 32-day measurement history. The forecast initially uses the same Stockholm clock time yesterday. With three or more distinct comparable days for a quarter, it uses the median at that time across weekdays or weekends. If yesterday’s quarter was unavailable at issuance, one or two comparable days can supply a fallback median. The independent yesterday baseline remains missing in that case. Repeated autumn clock times contribute a single daily observation. Missing readings stay unknown and a measured zero remains valid.

The view shows coverage, the peak quarter mean and its time, a full-horizon kWh total when available, and predicted versus measured kW. Issued predictions and their yesterday baselines persist locally across restarts. Rolling issues are retained for 48 hours. One non-overlapping 24-hour reference is kept per day for up to 30 days. No forecast is reconstructed for time when Homey was offline.

Day errors compare measured energy with predictions issued before the period. Mean absolute power errors compare the model and yesterday on the same observed quarters in completed daily references. The empirical range adds the 10th and 90th percentiles of signed daily errors to the complete forecast after 14 fully scored reference days. The range describes past errors and is not a calibrated guarantee. The model uses no external weather service or additional Modbus poll.

The private forecast endpoint is `GET /forecast/household`. Existing monitoring data, meter references and tariff calculations continue to use their original settings and history. Earlier simulation endpoints have been removed.

## Weather-based solar forecast

In **Settings → Prognos → Solprognos → Plats och takytor**, enable weather access and enter an approximate site and one to four roof planes. For each plane enter installed DC capacity (kWp), tilt from horizontal and compass bearing (north 0°, east 90°, south 180°, west 270°). Include the panels represented by the plant device’s selected solar source, including third-party PV where applicable. The suggested system loss is 14% and can be adjusted.

Homey requests mean tilted irradiance for each roof approximately hourly. Only coordinates, tilt, orientation and weather query parameters are sent. For each quarter, estimated Wh = irradiance in W/m² × installed kWp × 0.25 h × (1 − loss fraction). Some weather models interpolate hourly inputs. Fixed losses approximate AC output. Snow cover, local shade and inverter clipping can materially reduce actual production. Weather data and attribution: [Open-Meteo](https://open-meteo.com/en/docs), [terms for non-commercial use](https://open-meteo.com/en/terms).

Each successful weather update requests enough 15-minute estimates for the next 48 hours (192 complete quarters per roof, starting at the next UTC quarter boundary). The advisory battery plan still covers up to 24 hours. It can use the second day of the latest weather issue as its planning window moves between updates. The latest issue survives app restarts. Prognos and its accuracy evaluation use only the first 24 hours of each issue. When a newer issue arrives, Homey retains the first 96 quarters per roof of the superseded issue in the seven-day archive (up to 168 issues). Older 24-hour issues remain usable until the next successful weather update. Select an issue in Prognos to compare its original total with the selected Sigenergy solar source. The comparison uses matching completed quarters with full solar coverage, including eligible counter recovery. Missing values remain gaps. Sigenergy supplies the aggregate, so roof-level production is forecast only. The battery planner uses the current forecast as described in Battery and electricity prices.

### Same-day solar adjustment

Homey also issues an aggregate correction in the background after a quarter closes. It matches recent Sigenergy PV energy with the most recent original weather forecast issued before each corresponding interval, for the same roof configuration and solar source. At least three of the last four quarters must have full observed PV coverage, including the latest closed quarter. Each qualifying original must predict at least 2% of the installed peak power on average. Missing, partially measured and counter-estimated intervals cannot supply evidence for this correction.

The multiplier is the ratio of measured to forecast energy across those quarters, bounded between zero and 1.25. These initial thresholds are engineering assumptions. A sustained measured zero can lower the remaining forecast; improving production can raise it again. Corrections cover future complete quarters through Stockholm midnight and retain missing weather values. Each issued adjustment is stored alongside its original for the archive retention window. The Prognos tab lets you select the issue and adjustment time and compare both against subsequent Sigenergy production over the same quarters. The correction estimates aggregate production and does not identify the cause of a shortfall.

The accuracy table in Prognos evaluates the current roof configuration and selected solar source over the rolling seven-day issue archive. Each completed daylight quarter counts once, using the original and the latest applicable adjustment available when the quarter started. Daylight uses the same 2% threshold as calibration. The table shows the number with an adjustment and the number with a full observation, followed by the mean absolute error in Wh per paired quarter and the fraction of paired quarters for which each forecast exceeded the measured energy. An observed zero is valid. A missing reading, partial coverage or counter-based estimate cannot be scored. These scores describe the forecast that was in effect at the start of each quarter.

## Development and testing

```sh
npm ci
npm run check
npm run validate
npm run build:homey
```

`npm run check` enforces ESLint correctness rules (including inline view scripts), Prettier formatting and runtime coverage gates: 90% lines/statements, 90% functions and 85% branches. Coverage reports are available as CI artifacts. See [contributing](CONTRIBUTING.md#code-quality-and-formatting) for commands, scope and limitations.

`npm test` runs the built-in Node.js test runner. Tests cover household forecasting, Tibber normalization/refresh, history, advisory backup logic, mocked Nibe/EVDC reads, device connection-setting changes, telemetry validation, diagnostics, demand charges and marginal costs. Widget registration, API projection, error recovery and packaged files also have automated checks. These checks do not validate physical registers, Homey installation, actual Dashboard compatibility or safety behavior on hardware.

[GitHub Actions](.github/workflows/ci.yml) uses Node.js 24 and `npm ci` with the committed lockfile. It runs lint/format checks, the full test suite with coverage thresholds, matching manifest/package version checks, local-development Homey validation and a build including production dependencies on pushes and pull requests. Tests are limited to `test/*.test.js` so generated build copies are not run twice. `.homeyignore` excludes tests and development documentation from the app bundle. CI does not install on physical Homey or certify App Store readiness.

| Path | Purpose |
| --- | --- |
| `app.json`, `package.json` | Manifest, capabilities, device settings and dependencies |
| `app.js` | Runtime polling, caches and advisory calculations |
| `drivers/sigenergy/` | Fixed-identity pairing and plant polling |
| `settings/`, `widgets/` | App settings UI and Dashboard widgets |
| `lib/` | Readers, history, pricing and planning modules |
| `test/` | Automated calculation and mocked-reader tests |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Open an issue, make a focused branch, test changed calculations and open a pull request describing safety implications. Hardware reports should identify firmware, verified register source, widths/scaling and observed results, clearly separated from simulation.

Keep general-purpose Modbus operations read-only. Any future control work requires documented registers, safety review, explicit opt-in and hardware validation. Never commit API tokens, private network details, credentials or identifiable telemetry. Follow [SECURITY.md](SECURITY.md) for private vulnerability reporting when available.

## License

Released under the [MIT License](LICENSE). This is a community project; no vendor certification or affiliation is claimed.
