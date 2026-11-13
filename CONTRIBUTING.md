# Contributing

Contributions, bug reports and hardware register verification are welcome.

1. Open an issue describing the problem or enhancement.
2. Create a branch and make a focused change.
3. Run `npm run check`, `npm run validate` and `npm run build:homey`; include tests for changed calculations.
4. Open a pull request with a description of safety implications.

## Safety

Keep Modbus operations read-only. Do not add writes to the inverter, battery,
EV charger or heat pump without documented registers, safety review, explicit
opt-in, and hardware validation. Never commit API tokens, private IPs,
credentials, exported history, or personally identifying telemetry.

## Hardware validation

Clearly distinguish simulated results from values measured on physical devices.
Do not claim hardware compatibility based solely on unit tests.

Source-status rules live in `lib/source-status.js` and price coverage in `lib/pricing/coverage.js`. After editing them, run `node scripts/sync-source-status.js` to update the packaged browser copies in settings and the widget. Tests reject copies that differ from the shared module.

## Code quality and formatting

Use Node.js 24 (the CI version) and `npm ci` to install the locked tools.

- `npm run lint` checks Node/CommonJS code and JavaScript inside the settings/widget HTML. Warnings fail CI. `npm run lint:fix` applies supported automatic fixes.
- `npm run format` formats JavaScript, HTML, JSON and workflow YAML with Prettier, then synchronizes the shared status copies. `npm run format:check` verifies formatting without modifying files. Generated output, the lockfile and shared browser copies are excluded; a test verifies those copies match their canonical source.
- `npm run test:coverage` runs the full test suite through c8/V8 and enforces global minimums: **90% lines/statements, 90% functions and 85% branches**. `npm run check` combines lint, format checking, coverage and matching manifest versions.

Coverage includes every runtime file under `lib/` and `drivers/`, plus `app.js` and `api.js`, including files never loaded by tests (`all: true`). VM-loaded app/device fixtures use their real filenames so their execution is attributed to the source. Tests, development scripts, generated output and browser copies/inline HTML are outside the numeric coverage denominator. Browser behavior is still exercised by the UI transition tests; this report does not measure real-browser or physical-Homey coverage. Global thresholds can hide weak individual modules, so review the per-file report and test meaningful error paths rather than adding assertions only to raise a percentage.

Open `coverage/index.html` for per-file results. CI retains HTML, LCOV and JSON-summary reports in the coverage artifact for 14 days, including reports from failed coverage runs. Keep the thresholds checked in and raise them as useful tests improve coverage. The first adoption formats existing source in one pass; subsequent PRs should contain only formatting needed for their changes.
