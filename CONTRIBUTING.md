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

Source-status rules live in `lib/source-status.js`, price coverage in `lib/pricing/coverage.js`, and tariff validation/form parsing in `lib/tariff-config.js`. After editing them, run `node scripts/sync-source-status.js` to update the packaged browser copies in settings and the widget. Tests reject copies that differ from the shared module.

## Code quality and formatting

Use Node.js 24 (the CI version) and `npm ci` to install the locked tools.

- `npm run lint` checks Node/CommonJS code and JavaScript inside the settings/widget HTML. Warnings fail CI. `npm run lint:fix` applies supported automatic fixes.
- `npm run format` formats JavaScript, HTML, JSON and workflow YAML with Prettier, then synchronizes the shared status copies. `npm run format:check` verifies formatting without modifying files. Generated output, the lockfile and shared browser copies are excluded; a test verifies those copies match their canonical source.
- `npm run test:coverage` runs the full test suite through c8/V8 and enforces global minimums: **90% lines/statements, 90% functions and 85% branches**. `npm run check` combines lint, format checking, coverage and matching manifest versions.

Coverage includes every runtime file under `lib/` and `drivers/`, plus `app.js`, `api.js` and widget API handlers, including files never loaded by tests (`all: true`). VM-loaded app/device fixtures use their real filenames so their execution is attributed to the source. Tests, development scripts, generated output and browser copies/inline HTML are outside the numeric coverage denominator. Browser behavior is still exercised by the UI transition tests; this report does not measure real-browser or physical-Homey coverage. Global thresholds can hide weak individual modules, so review the per-file report and test meaningful error paths rather than adding assertions only to raise a percentage.

Open `coverage/index.html` for per-file results. CI retains HTML, LCOV and JSON-summary reports in the coverage artifact for 14 days, including reports from failed coverage runs. Keep the thresholds checked in and raise them as useful tests improve coverage. The first adoption formats existing source in one pass; subsequent PRs should contain only formatting needed for their changes.

### Adding a Dashboard widget

1. Register the widget in `app.json` and keep its `widgets/<id>/widget.compose.json` definition in sync. Run `node scripts/sync-source-status.js` to copy the shared layout assets into each registered widget.
2. Load `widget-layout.css` and `widget-layout.js` from the widget's `public/index.html`. Put all visible content, including controls, details, loading and error messages, inside one `<main id="widget-content">`. Apply widget-specific padding to that wrapper.
3. In `onHomeyReady(Homey)`, create one `WidgetLayout.create(Homey, { document, view: window })` instance. Call its `refresh()` on initial render and after rendering new content or errors. Call `dispose()` on permanent teardown. The helper reports the content height to Homey, watches viewport and content changes, and marks when the whole widget fits.
4. Keep viewport overflow rules in `lib/widget-layout.css` and fit detection in `lib/widget-layout.js`. Preserve native vertical panning and pinch zoom over charts and native interaction with controls. A fitted widget hands a fresh swipe to Dashboard; a constrained widget keeps its content reachable.
5. In the widget's browser test call `checkWidgetScroll(browser, widgetId, sampleReport, targetSelector)` from `test/browser/widget-scroll.cjs`. Pick a visible chart or content tile in a populated view. Run `npm run test:settings-ui` and verify the packaged assets with `npm run build:homey && node scripts/verify-widget.js`. On iPhone/iPad, let Dashboard stop, swipe from the middle of the widget, and repeat after expanding details or changing the displayed period.

Cost contract validation is shared by Node and settings through `lib/pricing/cost-model.js`; the sync script generates `settings/cost-model.js`. Preserve explicit component provenance, tax inclusion, directional energy and matching battery boundaries.

Native Energy companions share `lib/energy/reporting.js` and the existing plant's in-memory snapshot. Keep them free of Modbus connections and control capabilities. Treat source loss as unavailable, preserve signs/real zero, test lifecycle races, and keep kWh behind a documented register profile, preserve integer high-water state before publication, and test reset/source-change acknowledgement. Never substitute rolling history or Tibber imports for cumulative counters. See `docs/homey-energy.md`.

## Settings interface

The settings page is grouped into categories. Navigation only hides and shows existing
sections; switching categories does not save, discard, or re-create form inputs. Keep
existing input IDs and save handlers stable. Use native labels, keyboard navigation,
visible focus indicators, and layouts that work in narrow and dark webviews.

Tailwind CSS and its CLI are locked development dependencies. Edit
`settings/tailwind.css` and local HTML/JavaScript, then run `npm run build:css` and
commit the generated `settings/styles.css`. Explicit `@source` rules scan only the
settings HTML and JavaScript. Use complete class names for generated elements.
The app loads the compiled stylesheet locally; it needs no Tailwind CDN or runtime.

`npm run check:css` rejects stale compiled CSS in CI. `npm run build:homey` rebuilds
it before packaging. `node scripts/verify-settings.js` checks the packaged settings
assets, and release verification repeats that check on the extracted archive.
An extracted release can be installed without the Tailwind development tools.
Verify navigation and form saves in light/dark modes at phone and desktop widths;
synthetic browser checks do not establish physical Homey or iOS compatibility.

The Homey settings SDK loads its unlayered legacy stylesheet after the app CSS.
App-owned form elements use the SDK's `hy-nostyle` opt-out. Keep Tailwind-composed
settings rules unlayered and scoped to `body.sigenergy-settings`; placing them in
`@layer components` would let the host reset override borders, padding and focus.
Do not modify Homey's `homey-form-*` classes or add a blanket `!important` reset.

Run `npx playwright install chromium` once, then `npm run test:settings-ui`.
The browser regression loads a synthetic, unlayered host reset last and checks
all categories at phone and desktop widths, in light and dark modes. It verifies
four-sided field borders, contrast, spacing, touch targets and keyboard focus.
CI installs Chromium and runs this check. Vendor CSS and household data are not
included in the fixture. For a local SDK comparison, `SETTINGS_HOST_CSS` can point
to a private stylesheet bundle; do not commit that file or private screenshots.

`settings/settings-assistant.js` provides draft-only setup helpers: named tariff
weekdays, a checked-date shortcut and read-only
unit explanations. It must not call Homey APIs, apply tariff presets, publish
contract dates or attest historical assumptions. Host callbacks explicitly refresh
weekday controls after successful reads; failed reads keep bulk actions
disabled. Numeric inputs and persisted schemas retain their original units and
precision. Conversions describe the draft without normalizing or changing it.

The browser test also covers these interactions, existing irregular day selections,
explicit saves, hidden required fields and read failures.
Preserve the existing validators and keep advanced fields discoverable when invalid.

Forecast tests exercise cold starts, missing quarters, Stockholm clock changes, frozen predictions after restart and scoring against subsequently measured outcomes. The browser suite renders the forecast from a synthetic local household history. Keep the Homey household's data out of fixtures and pull requests.
