# Sigenergy Local Monitor for Homey

Experimental Homey SDK v3 app for local, read-only Sigenergy monitoring, optional Nibe SMO S40 temperature readings, and advisory energy planning.

**Version 0.17.0 · Learning mode only · MIT licensed**

The project targets a Homey Pro 2023 and SigenStor EC 17.0 TP setup. **Basic installation, pairing, plant readings and recovery after a Homey reboot were tested on one physical Homey Pro running firmware 13.5.4 on 2026-11-13.** The user confirmed the base readings against mySigen with unit ID 247. See the [verification record](docs/installation-verification.md) for scope and remaining tests. Exact inverter firmware and the full register profile remain unverified; EVDC, Nibe, optional battery telemetry and island/safety behavior have not been hardware-validated. Unit tests do not establish hardware compatibility or safe operation.

## Features and implementation status

| Area | Implemented in source | Status and limits |
| --- | --- | --- |
| Sigenergy monitoring | Battery SoC and capacity, grid/PV/battery power, grid mode; Homey device capabilities | Local Modbus TCP reads; one plant per Homey through a fixed pairing identity |
| Battery telemetry | Optional power limits, available energy, nominal power, SoC cutoffs and SoH | Probed about every five minutes; individual failures do not invalidate the main snapshot; registers and scaling unverified |
| EVDC monitoring | Optional charging power and vehicle SoC reads | Experimental and disabled by default; no charger control |
| Nibe monitoring | SMO S40 outdoor, hot-water, supply and return temperatures | Optional local reads every 30 seconds; no separate Homey device and no heat-pump control |
| Backup advisory | Grid/island/unknown state and a “Backup mode changed” Flow trigger | EV-stop and Nibe-mode tokens are requests, never confirmation of an action |
| Local history | Quarter-hour aggregates, daily summaries, backup-mode events and JSON export | Stored in Homey app settings, not a dedicated database |
| Tibber prices and EV planning | Cached consumption prices and a price-based charging planner | Internet needed for refresh; planning only; no automatic execution |
| Peak shaving | Historical replay, configurable caps/reserves, stored advisory recommendations | Illustrative scenarios, not a forecast or guaranteed power limit |
| Demand charges | Configurable hourly peak selection and historical tariff scenarios | Provisional; no verified Telge Nät tariff supplied |
| Dashboard | Energy overview widget candidate with history, recommendations and demand estimates | Packaging and Dashboard runtime unverified; history is not live telemetry |
| Marginal energy costs | Separate import/export, tax, grid-fee and battery-wear calculations | Standalone tested module; not connected to production prices, Dashboard or runtime scenario ranking |

The app settings page is primarily Swedish. It includes **Översikt** (overview), **Elpriser** (prices), **Historik** (history), **Optimering** (optimization), **Diagnostik** (diagnostics) and **Inställningar** (settings).

## Read-only safety boundary

There are no Modbus write calls or automatic battery, EVDC or Nibe control adapters in this build. Operation mode is forced to learning mode with `allowHardwareWrites: false`; changing settings cannot enable hardware writes.

Backup logic interprets input register 30009 as 0 = grid, 1/2 = island, anything else = unknown. Grid restoration requires five minutes of successful grid readings, including after app startup. Communication failure returns the advisory state to unknown. Island or unknown state requests EV stop and a restricted Nibe mode; below 25% battery SoC it requests critical mode. **No stop, auxiliary-heat block or restart is executed.** Verify the register mapping against your firmware.

Homey polling is not fuse protection, load balancing or an outage fail-safe. Keep native inverter/charger protections and Nibe frost protection and existing local schedules active. Do not switch heat-pump mains with a smart relay as a substitute for a validated control interface. Homey and networking must remain powered for monitoring during an outage.

## Prerequisites

- A local Homey installation. The manifest declares SDK 3, local platform only and Homey firmware `>=12.0.0`; this is a declared minimum, not a tested compatibility matrix.
- Sigenergy reachable from Homey over the LAN, with Modbus TCP read access enabled in mySigen and permitted by firmware/network configuration.
- Verified register addresses, widths, scaling, word order and address-offset convention for your hardware. The current Sigenergy map derives from an [unofficial V2.5 protocol transcription](https://github.com/krzychdre/modbus-sigenergy/blob/main/Sigenergy_Modbus_Protocol_V2.5.md).
- Git, Node.js and npm on the development computer. Use Node.js 24 (the CI version) and npm. The project requires Node.js 24+ and pins Homey CLI 4.6.3 in its development dependencies. Follow the [official setup requirements](https://apps.developer.homey.app/the-basics/getting-started) for Docker and local execution.
- Optional: a Tibber API token/subscription with consumption prices, or a Nibe SMO S40 with Modbus TCP/IP enabled and its own register export checked.

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

See the [official Homey CLI reference](https://apps.developer.homey.app/the-basics/getting-started/homey-cli) for validation, runtime options and troubleshooting. The commands above use the repository's locked CLI; a global installation is unnecessary. Validation uses the `debug` level for local development, not App Store certification. The battery device class requires Homey 12.0.0 or newer; the declared minimum is not proof of physical compatibility. See [installation verification](docs/installation-verification.md) for observed results and the pending hardware checklist.

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

The runtime fetches on startup when configured and checks refresh eligibility every five minutes. Refresh is normally hourly; after 13:00 Europe/Stockholm it retries at 15-minute intervals while tomorrow's prices are missing. Failed requests keep the previous cache. The settings page's save message still mentions 30 minutes; the runtime policy above is authoritative. Restarting the app triggers a configured fetch.

The GraphQL query reads **consumption** `priceInfo.today/tomorrow.total`. Normalization accepts hourly or quarter-hour intervals inferred from adjacent start times. Tomorrow's availability and a continuous 48-hour horizon are not guaranteed. Inspect `priceCache.fetchedAt`, interval coverage and `priceError`; cached prices can remain usable offline only for the intervals they cover.

The charging planner needs an explicitly supplied current vehicle SoC and assumes fixed available power and a connected vehicle. Missing coverage or insufficient energy can leave targets unmet. It does not enforce per-phase limits, couple household/solar/storage dispatch, or execute a plan. Its cost estimate uses the supplied consumption prices, not a verified all-in bill.

The standalone [cost model](lib/pricing/cost-model.js) treats consumption input as VAT-inclusive, adds configurable tax and variable import-grid charges with VAT once, and takes a **separate signed export payout** plus export benefit/fee. Fixed subscription and demand charges are separate from marginal kWh prices. The app does not fetch actual Tibber production-contract payouts or wire this model into runtime ranking. Tax, fee and VAT inputs must come from the applicable contract; no current rates are supplied.

## Telge Nät demand-tariff assumptions

This is a configurable estimator, **not a verified implementation of Telge Nät's current contract**. No tariff object or rate is installed by default. The form initially shows 07:00–19:00, weekdays, three peaks and distinct days; tests use five-peak examples and the widget has a five-peak label. None of these establishes your actual tariff.

Configure `start`, `end`, `weekdays` (0 = Sunday), `peakCount`, `distinctDays` and `rateSekPerKw` from your confirmed price list. The calculation library also supports optional `months` (1–12); the settings form does not expose season selection and saving it does not preserve that field.

The estimator:

- Uses Europe/Stockholm calendar dates and full-hour windows within one day.
- Requires four contiguous, aligned quarter-hour energy records per eligible hour, each with at least 14 minutes of coverage.
- Sums signed `gridWh` for the hour, clamps net export to zero, selects the highest configured number of hourly values (optionally from distinct days), and multiplies their mean kW by the configured SEK/kW rate.
- Returns `insufficient-data` until enough eligible peaks exist; otherwise the estimate remains `provisional`.

Holiday exclusions are not implemented, full-month completeness is not guaranteed, and older records without coverage cannot qualify. Thirty-day detailed retention can omit part of a 31-day month. Verify seasonal rules, import/export treatment, peak selection, VAT basis and rate against your contract. Displayed savings are historical scenarios, not billing-accurate or future savings.

## History, diagnostics and simulations

History is retained in Homey settings for up to 30 days of quarter-hour records, 730 daily summaries and 500 events. Power integration requires adjacent observations no more than 60 seconds apart within the same slot; gaps are not filled. Daily summaries use UTC dates, whereas tariffs use Stockholm time.

Export JSON manually from app settings. Export excludes the Tibber token but still contains private usage patterns; keep it private or sanitize it before sharing. There is no guaranteed backup or reimport workflow.

Diagnostics show source errors and freshness. The overview and widget use saved history rather than live device capabilities. The widget refreshes every 30 seconds and flags history older than 30 minutes; recommendations older than 35 minutes are hidden. Its packaging and behavior still need physical Homey verification.

The settings-page simulator assumes no recharge. Advanced replay accepts explicitly supplied unused solar surplus and timestamp-matched prices; it does not infer surplus from PV production. Runtime recommendations refresh every 15 minutes. Tariff scenarios compare the same hourly model for baseline and replay; without complete matching energy-price inputs, runtime results concern demand charges only, not total economic savings.

Developer entry points in [app.js](app.js) include `getPricePlan(currentSoc)`, `getOptimizationPreview()`, `getAdvancedOptimizationPreview(options)` and `getDemandCharge(month)`. These are app methods, not published HTTP endpoints. Solar allocation in [lib/charging/dispatch.js](lib/charging/dispatch.js) is a separate simulator with illustrative efficiency curves and is not wired into runtime dispatch.

## Development and testing

```sh
npm ci
npm test
npm run check:versions
npm run validate
npm run build:homey
```

`npm test` runs the built-in Node.js test runner. Tests cover charging plans, solar allocation, Tibber normalization/refresh, history, advisory backup logic, mocked Nibe/EVDC reads, device connection-setting changes, telemetry validation, diagnostics, replay, demand charges and marginal costs. They do not validate physical registers, Homey installation, widget packaging, actual API contracts or safety behavior on hardware.

[GitHub Actions](.github/workflows/ci.yml) uses Node.js 24 and `npm ci` with the committed lockfile. It runs tests, matching manifest/package version checks, local-development Homey validation and a build including production dependencies on pushes and pull requests. Tests are limited to `test/*.test.js` so generated build copies are not run twice. `.homeyignore` excludes tests and development documentation from the app bundle. CI does not install on physical Homey or certify App Store readiness.

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

