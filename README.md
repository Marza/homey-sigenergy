# Sigenergy Local Monitor for Homey

Experimental Homey SDK v3 app for local, read-only Sigenergy monitoring, optional Nibe SMO S40 temperature readings, and advisory energy planning.

**Version 0.17.0 · Learning mode only · MIT licensed**

The project targets a Homey Pro 2023 and SigenStor EC 17.0 TP setup. **Basic installation, pairing, plant readings and recovery after a Homey reboot were tested on one physical Homey Pro running firmware 13.5.4 on 2026-11-13.** The user confirmed the base readings against mySigen with unit ID 247. **Nibe SMO S40 Modbus reads also worked after Modbus was enabled, and the user confirmed all four temperatures against the Nibe display.** See the [verification record](docs/installation-verification.md) for scope and remaining tests. Exact inverter firmware and the full register profile remain unverified; EVDC, optional battery telemetry and island/safety behavior have not been hardware-validated. Unit tests do not establish hardware compatibility or safe operation.

## Features and implementation status

| Area | Implemented in source | Status and limits |
| --- | --- | --- |
| Sigenergy monitoring | Battery SoC and capacity, grid/PV/battery power, grid mode; Homey device capabilities | Local Modbus TCP reads; one plant per Homey through a fixed pairing identity |
| Battery telemetry | Optional power limits, available energy, nominal power, SoC cutoffs and SoH | Probed about every five minutes; individual failures do not invalidate the main snapshot; registers and scaling unverified |
| EVDC monitoring | Optional charging power and vehicle SoC reads | Experimental and disabled by default; no charger control |
| Nibe monitoring | SMO S40 outdoor, hot-water, supply and return temperatures | Four readings verified against the display on one installation; optional local reads every 30 seconds, no separate Homey device or heat-pump control |
| Backup advisory | Grid/island/unknown state and a “Backup mode changed” Flow trigger | EV-stop and Nibe-mode tokens are requests, never confirmation of an action |
| Native Homey Energy | Optional grid, solar and battery power-reporting companions | W/% plus opt-in V2.9 cumulative kWh profile; physical counter/history verification pending |
| Local history | Quarter-hour aggregates, daily summaries, backup-mode events and JSON export | Stored in Homey app settings, not a dedicated database |
| Tibber prices and EV planning | Cached consumption prices and a manual-SoC charging-plan preview | Authenticated dry run with coverage, deadlines and unmet targets; no charging commands |
| Peak shaving | Historical replay, configurable caps/reserves, stored advisory recommendations | Illustrative scenarios, not a forecast or guaranteed power limit |
| Demand charges | Configurable hourly peak selection and historical tariff scenarios | Provisional; dated Telge rules documented, billing comparison pending |
| Dashboard | Energy overview widget with history, outdoor temperature, recommendations and demand estimates | Registered and package-checked; physical Dashboard testing pending; history is not live telemetry |
| Marginal energy costs | Separate import/export, tax, grid-fee and battery-wear calculations | Standalone tested module; not connected to production prices, Dashboard or runtime scenario ranking |

The app settings page is primarily Swedish. It includes **Översikt** (overview), **Elpriser** (prices), **Historik** (history), **Optimering** (optimization), **Diagnostik** (diagnostics) and **Inställningar** (settings).

## Read-only safety boundary

There are no Modbus write calls or automatic battery, EVDC or Nibe control adapters in this build. Operation mode is forced to learning mode with `allowHardwareWrites: false`; changing settings cannot enable hardware writes.

Backup logic interprets input register 30009 as 0 = grid, 1/2 = island, anything else = unknown. Grid restoration requires five minutes of successful grid readings, including after app startup. Communication failure returns the advisory state to unknown. Island or unknown state requests EV stop and a restricted Nibe mode; below 25% battery SoC it requests critical mode. **No stop, auxiliary-heat block or restart is executed. Current economic advice and charging previews are paused while backup state is restricted or stale; historical simulations remain explicitly qualified. See [backup advisory behavior and future-control gate](docs/backup-advisory.md).** Verify the register mapping against your firmware.

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
| `evdcEnabled` | `false` | Enable experimental EVDC reads only after register verification |

Compare SoC, capacity, grid power and PV power against mySigen. The code assumes **positive grid power = import**, negative = export; **positive battery power = charging**, negative = discharging.

EVDC defaults are power register `31502` (two unsigned 16-bit words) and SoC register `31504` (one word), with divisors `evdcPowerScale = 1` and `evdcSocScale = 1`. Addresses and divisors are device settings; widths are fixed in the reader. Do not enable probing until all of these match your firmware. EVDC errors are recorded separately from plant monitoring.

### App settings

- **Nibe:** Enter host, port (502), unit ID (1) and address offset (0). An empty host disables polling. The profile assumes signed 16-bit input registers divided by 10: 1 = BT1/outdoor, 8 = BT7/hot water, 39 = BT25/supply, 88 = BT71/return. Verify all four against your SMO S40 register export; a missing sensor can fail the snapshot. The runtime does not calculate Nibe tariff windows or replace its local schedule.
- **EV schedule:** Default minimum 30% by 07:00 Europe/Stockholm, with optional weekday departure targets. The model assumes 75 kWh usable capacity, 92% efficiency and 10 kW maximum charging power. These are estimates, not verified vehicle specifications. The UI exposes capacity, power and targets; efficiency is held in `chargingConfig`.
- **Peak-shaving simulation:** Configure the cap range/step, battery capacity, initial SoC, charge/discharge limits, reserves, efficiency and wear estimate. Defaults are illustrative. Automatic battery values use telemetry no older than ten minutes, otherwise manual values apply; observed power limits can only lower simulated power. Current BMS limits are not historical or future capability guarantees. No measured battery-temperature register is implemented.
- **Tariff:** Enter confirmed contract values as described below. Saving a form does not verify the tariff.

### Tibber prices and pricing caveats

Save the token and, for multiple homes, the exact Tibber Home ID in app settings. The token is stored in Homey settings and used in requests to `https://api.tibber.com/v1-beta/gql`. Price-cache objects and history exports exclude it. Do not share tokens or settings containing credentials.

The runtime fetches on startup and checks eligibility every five minutes. It normally refreshes hourly; after 13:00 Europe/Stockholm it retries at 15-minute intervals until the whole of tomorrow is covered. Missing current prices also select 15-minute retries. Saving credentials makes the next check eligible. Failed requests retain the previous cache and its still-valid, verified intervals; the error is shown separately from price coverage.

The query explicitly requests **quarter-hour consumption** `priceInfo(resolution: QUARTER_HOURLY).today/tomorrow` with `total`, `startsAt` and `currency`. Normalization uses the requested fixed resolution, never stretches a price across missing starts, rejects conflicts/invalid values and accepts negative prices. The app currently accepts SEK only. Identical duplicates are counted once. Tomorrow is complete only with full Stockholm-day coverage (23/24/25 hours); partial publication remains partial. No continuous 48-hour horizon is promised. Older price caches with inferred ends are not used for planning until a fresh validated fetch. See [Tibber contract, fixtures and coverage](docs/tibber-prices.md).

The settings page reports available intervals, gaps, last fetch/attempt/error and earliest refresh eligibility. The charging planner requires explicit vehicle SoC and assumes fixed power and a connected vehicle. It exposes price coverage per deadline, never treats unknown prices as zero, and marks feasible plans with incomplete prices as `partial-prices`. Missing energy remains unmet. It does not enforce per-phase limits, couple household/solar/storage dispatch or execute a plan. Its cost estimate uses supplied consumption prices, not a verified all-in bill or actual export payout.

The [cost model](lib/pricing/cost-model.js) uses explicit contract inputs from settings: additional tax and variable grid fees, signed export benefit/fee, VAT and battery wear, with a source and check date. Import is VAT-inclusive; energy tax already included in that price must not be added again. No current contract rates are supplied. The authenticated economic-preview API compares only complete, timestamp-matched directional import/export series with matching initial/final battery energy. Its results are provisional user-supplied calculations, not verified invoices. The current replay remains **demand-charge-only**: a scalar baseline cost or consumption prices cannot enable net financial ranking. Actual production-contract pricing and directional replay integration remain unavailable. See [economic comparison inputs and limits](docs/economic-comparison.md).

## Telge Nät demand-tariff assumptions

This is a configurable estimator, **not a verified implementation of Telge Nät's current contract**. No tariff object or rate is installed by default. The form starts without times, weekdays, peak count, rate, day-selection rule or season assumptions. Holiday exclusions are an explicit opt-in. Existing settings are loaded explicitly. Example tariffs in tests do not establish your contract.

Configure `start`, `end`, `weekdays` (0 = Sunday), `peakCount`, `distinctDays` and `rateSekPerKw` from your confirmed price list. Select active `months` (1–12) or explicitly choose **Hela året** (all year). Existing seasonal selections survive edits; all-year tariffs omit `months`. UI and backend share the same validation: full-hour times within one day, unique valid weekdays/months, an integer peak count of 1–31, a non-negative finite rate and an explicit day-selection rule. Empty fields are not treated as zero or a default contract.

Widget labels follow the configured peak count. Tariff edits refresh the demand estimate immediately. Historical scenario replays keep their periodic schedule; cached results with a different tariff configuration or calendar month are hidden until recalculated. Months outside the configured season are labelled inactive. These checks establish configuration consistency, not that the tariff matches Telge Nät’s contract.

The estimator:

- Uses Europe/Stockholm calendar dates and full-hour windows within one day.
- Requires four contiguous, aligned quarter-hour energy records per eligible hour, each with at least 14 minutes of coverage.
- Sums signed `gridWh` for the hour, clamps net export to zero, selects the highest configured number of hourly values (optionally from distinct days), and multiplies their mean kW by the configured SEK/kW rate.
- Returns `insufficient-data` until enough eligible peaks exist; otherwise the estimate remains `provisional`.

Select **Telge: svenska helgdagar, julafton och nyårsafton undantas** (`calendar: "se-telge"`) to exclude Swedish public holidays plus Christmas Eve and New Year’s Eve. Omitted `calendar` or `"none"` retains the generic weekday-only calculation; existing tariffs are not silently migrated. The selected calendar is part of result identity, so changing it hides old results until recalculation.

The result includes `coverage`: expected eligible hours in the full Stockholm calendar month, elapsed closed hours, complete observed hours, missing elapsed hours, remaining hours and `complete`/`partial` coverage. Completely absent hours count as missing. Future/open hours cannot qualify. Duplicate quarter records invalidate that hour. Real UTC hours are enumerated separately across DST, then filtered by local dates. The widget shows measured/expected, missing and remaining hours for both the estimate and historical scenario. A sufficient set of observed peaks still yields a **provisional estimate for observed hours**, not a complete-month bill. Replay uses the same calculation time and eligible-hour model, and explicitly reports `scope: "observed-hours"`. Unobserved loads cannot be simulated.

See [dated Telge rules and validation gaps](docs/telge-tariff.md) for the public 2026 tariff reference, reproducible synthetic example and remaining billing checks. Older records without coverage cannot qualify. The 32-day detailed window can retain the full current calendar month, including a 31-day month with a DST transition; this is a storage bound, not proof that every interval was observed. Verify seasonal rules, import/export treatment, peak selection, VAT basis and rate against your contract. Displayed savings are historical scenarios, not billing-accurate or future savings.

Automatic daily Tibber consumption fetching supplies a **separate hourly demand reference** for the current Stockholm month, including available hours before app installation. It re-fetches the elapsed current month and the whole previous month to include delayed values and corrections, retaining the current month plus twelve previous months; failed requests retain the previous snapshot and retry after an hour. Fetching uses the saved Tibber token/home selection and starts within five minutes of app startup when due. The widget displays it alongside, rather than merged into, inverter history. Imported hours retain their hourly resolution/source and cannot supply missing PV, ESS or SoC for battery replay. Missing/delayed Tibber values stay missing. See [hourly consumption reference](docs/tibber-consumption.md) for scope, storage and backup limits.

## Native Homey Energy

Optional **Sigenergy Energy — grid / solar / battery** devices report fresh power from the existing plant reader through standard Homey capabilities. Pair only the sources you need and exclude duplicate P1/Tibber/solar integrations from Energy. Existing plant pairing, settings and history remain intact. The companions reuse the existing reader and add no device commands. Optional cumulative kWh uses a documented Sigenergy V2.9 statistics profile, five read-only counter reads at most once per minute and persistent monotonic guards. Enable the profile only after verifying firmware support; it defaults to power-only. Existing companions acquire the kWh fields without re-pairing. Native kWh history, source counter agreement and AC measurement boundaries still require physical verification. See [setup, source mapping and physical checklist](docs/homey-energy.md). The custom Dashboard widget is separate.

## History, diagnostics and simulations

History is committed as one bounded snapshot in Homey settings, retaining up to 32 days of quarter-hour records (3,072 slots), 730 Stockholm-calendar daily summaries and 500 events. Each field has independent observation counts and continuity, so optional EVDC samples cannot dilute plant averages or interrupt plant energy integration. Power integration requires valid observations no more than 60 seconds apart; short intervals crossing quarter boundaries are split using linear interpolation. Longer gaps and app-restart gaps are not filled. New daily summaries use Europe/Stockholm dates with explicit partial/complete coverage; 23- and 25-hour days are handled. Archived day totals are not overwritten by a truncated retained suffix. Older UTC daily summaries are preserved separately.

Quarter-hour records retain schema 2; the canonical snapshot and unified JSON export use schema 3. Older records remain available but are not retroactively repaired, and the UI does not invent per-field means from their shared sample count. If a new sample overlaps an older active quarter, its original data is preserved under `legacy` rather than merged into the new calculations. See [history format and migration](docs/history-format.md) for the record fields and limits.

Export a versioned combined JSON backup manually from app settings. It includes inverter history and retained monthly Tibber references; older history-only exports remain accepted. Export excludes the Tibber token but still contains private usage patterns; keep it private or sanitize it before sharing. The settings page can preview and merge a previous export. Existing intervals win on overlap, so energy is not added twice or overwritten. Legacy exports are validated and accepted; configuration and credentials are never restored. Meter references from a different configuration revision require explicit confirmation that they belong to the currently configured Tibber home. Restore uses separate, retry-safe commits for inverter history and meter references; see [backup format and recovery](docs/history-format.md#combined-backup-and-meter-archive). A 1 MiB meter-archive budget, 4 MiB inverter snapshot budget and 8 MiB input-file limit are application limits, not a claimed Homey capacity guarantee. Full-window storage and restore transport on physical Homey remain to be tested before issue #6 is considered hardware-verified.

Diagnostics use the same source-status rules in the backend, settings and widget: disabled/unconfigured, waiting for data, fresh, partial optional-battery data, stale, or failed. EVDC enablement comes from the actual device configuration, even before its first successful read. Optional battery register errors are shown individually; an entirely failed optional probe is not healthy. Connection refusal, timeouts and unsupported registers have explanatory messages.

The settings page refreshes every 15 seconds and the widget every 30 seconds. Failed, disabled, stale or future-dated sources hide their overview readings and temperature/BMS context. Changing Nibe connection settings clears its old snapshot and ignores in-flight results from the earlier configuration. Re-enabling a source requires a new reading. Automatic battery inputs reject failed, stale and future-dated telemetry and exclude failed fields; otherwise manual simulation values apply. Sigenergy status expires after at least 30 seconds (or three configured polling intervals), Nibe/EVDC after 90 seconds (EVDC also allows three polling intervals), and optional battery data after ten minutes. These are software freshness limits, not guarantees of sensor accuracy.

The overview and widget use saved quarter-hour averages rather than live device capabilities and label them as history. Historical charts remain available with their timestamps; overview cards clear on missing/failed history or intervals older than 30 minutes. Recommendations older than 35 minutes or dated in the future are hidden. The widget uses its scoped read-only API and is checked in the built app and extracted release archive. Local synthetic light/dark browser previews are available; add/remove and runtime behavior on physical Homey remain unverified. See [Dashboard verification](docs/dashboard-widget.md).

The settings page and runtime use the same [shared simulation engine](lib/optimization/simulator.js), including validation, chronological interval handling, battery limits and minimum-data checks. The settings-page simulator assumes no recharge. Advanced replay accepts explicitly supplied unused solar surplus and timestamp-matched prices; it does not infer surplus from PV production. Runtime recommendations refresh every 15 minutes. Tariff scenarios compare the same hourly model for baseline and replay; without complete matching energy-price inputs, runtime results concern demand charges only, not total economic savings.

Simulation requires at least eight valid, aligned quarter-hour observations and the configured coverage fraction (default 80%) over the supplied history span, counting completely absent quarters. Duplicate timestamps invalidate all copies; unaligned, missing-energy and invalid-coverage records are excluded. Below that threshold the UI clears scenario rows and returns `insufficient-data`, not an empty-history optimum. Limits of 200 values per axis, 1,000 scenarios and 3,072 input quarters prevent unbounded loops; excessive ranges are rejected rather than silently truncated.

Results include the model, coverage and explicit assumptions: starting SoC/capacity, reserves, power limits, efficiency and whether surplus or prices were supplied. The starting SoC (including a fresh current BMS value when enabled) is an assumption for replaying the historical window, not a reconstruction of its true starting battery state. Starting below a reserve does not create charge. Gaps remain unmodelled, and sufficient coverage is not proof of a complete month or a calibrated battery model. The settings page exposes conservative replay only; advanced recharge still requires explicit timestamped unused-surplus inputs through the developer method. See [simulation models and limits](docs/simulation.md).

The charging settings include a **Laddplan – förhandsvisning utan styrning** preview. Supply manually read vehicle SoC, its observation time (no older than 15 minutes), assumed continuous connection and available power. Saved charging targets, usable capacity, efficiency and timestamp-matched Tibber prices determine the result. EVDC SoC is not used automatically while its register profile remains unverified. The preview displays its limited cost basis, price horizon/gaps, configured timezone, deadlines and unmet energy, and clears when inputs change or SoC expires. It does not account for driving between deadlines, solar allocation, household/storage dispatch or enforced network/phase/fuse limits. See [charging-plan preview](docs/charging-preview.md) for states and DST rules.

Developer entry points in [app.js](app.js) include `getPricePlan(currentSoc)`, `getOptimizationPreview()`, `getAdvancedOptimizationPreview(options)` and `getDemandCharge(month)`. The charging preview is exposed through authenticated POST `/charging/preview`; the other calculation entry points are not published HTTP endpoints. Separate, authenticated history export/preview/merge endpoints support the settings-page backup workflow; see [history format and storage](docs/history-format.md). Solar allocation in [lib/charging/dispatch.js](lib/charging/dispatch.js) is a separate simulator with illustrative efficiency curves and is not wired into runtime dispatch.

## Development and testing

```sh
npm ci
npm run check
npm run validate
npm run build:homey
```

`npm run check` enforces ESLint correctness rules (including inline view scripts), Prettier formatting and runtime coverage gates: 90% lines/statements, 90% functions and 85% branches. Coverage reports are available as CI artifacts. See [contributing](CONTRIBUTING.md#code-quality-and-formatting) for commands, scope and limitations.

`npm test` runs the built-in Node.js test runner. Tests cover charging plans, solar allocation, Tibber normalization/refresh, history, advisory backup logic, mocked Nibe/EVDC reads, device connection-setting changes, telemetry validation, diagnostics, replay, demand charges and marginal costs. Widget registration, API projection, error recovery and packaged files also have automated checks. These checks do not validate physical registers, Homey installation, actual Dashboard compatibility or safety behavior on hardware.

[GitHub Actions](.github/workflows/ci.yml) uses Node.js 24 and `npm ci` with the committed lockfile. It runs lint/format checks, the full test suite with coverage thresholds, matching manifest/package version checks, local-development Homey validation and a build including production dependencies on pushes and pull requests. Tests are limited to `test/*.test.js` so generated build copies are not run twice. `.homeyignore` excludes tests and development documentation from the app bundle. CI does not install on physical Homey or certify App Store readiness.

| Path | Purpose |
| --- | --- |
| `app.json`, `package.json` | Manifest, capabilities, device settings and dependencies |
| `app.js` | Runtime polling, caches and advisory calculations |
| `drivers/sigenergy/` | Fixed-identity pairing and plant polling |
| `settings/`, `widgets/` | App settings UI and Dashboard widget candidate |
| `lib/` | Readers, history, pricing and planning modules |
| `test/` | Automated calculation and mocked-reader tests |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Open an issue, make a focused branch, test changed calculations and open a pull request describing safety implications. Hardware reports should identify firmware, verified register source, widths/scaling and observed results, clearly separated from simulation.

Keep Modbus operations read-only. Any future control work requires documented registers, safety review, explicit opt-in and hardware validation. Never commit API tokens, private network details, credentials or identifiable telemetry. Follow [SECURITY.md](SECURITY.md) for private vulnerability reporting when available.

## License

Released under the [MIT License](LICENSE). This is a community project; no vendor certification or affiliation is claimed.

