# Dashboard widget validation

## Supported target and implementation

The app now declares **Homey >=12.3.0**, local platform only, following the [official widget requirements](https://apps.developer.homey.app/the-basics/widgets). This raises the earlier 12.0.0 minimum. Physical app monitoring has been tested on Homey Pro firmware 13.5.4; it does **not** establish widget compatibility at either version. Homey Cloud is outside the target.

This repository does not use Homey Compose. Merely including `widget.compose.json` did not register the widget in `app.json`; the widget is now explicitly registered there as `energy-overview`. Tests compare both definitions. The former numeric height of 2 would mean pixels, not grid rows. It is removed, and the widget reports its content height at runtime after rendering, including error states.

The widget uses `Homey.api('GET', '/')` and its scoped `getOverview` handler. It does not depend on the settings-view `Homey.get` API. The handler reads persisted app data only, projects an allowlist of overview fields and returns at most the latest history quarter. It omits credentials, private connection values, raw error messages, full history and unknown fields. Error categories retain useful connection-refused/timeout/register explanations without echoing host addresses. No device commands or additional permissions are introduced.

Data refreshes every 30 seconds. Failed/malformed responses and requests exceeding ten seconds clear displayed values and show a retry message. Late responses cannot overwrite a newer refresh. History, source freshness, tariff identity/month and provisional labels remain checked. History time is formatted explicitly in Europe/Stockholm. Overview readings remain saved averages, not live device values.

## Automated and local evidence — 2026-11-13

- Tests check direct manifest registration, one GET route, scoped snapshot projection, credential/address omission, empty/legacy/invalid history, settings failures, asynchronous loading, network recovery, timeout, late-response suppression and height updates. Existing rendering fixtures now exercise the real snapshot handler rather than granting a widget the settings API.
- Build validation checks the widget API, public entry point/shared modules and both preview images. Release verification repeats these checks on the extracted archive before publishing. The locked Homey CLI produces the widget preview assets.
- Light and dark layouts were visually inspected in local Chrome with a **400 × 900** viewport, using a synthetic API bridge. Both fit horizontally and keep units and advisory/coverage labels readable. A wider local browser view was also inspected. The light/dark preview PNGs were captured from these synthetic views; they contain no household measurements or account identifiers. This is local browser evidence, not a physical Dashboard test.
- No minimum mobile-app or Dashboard client version has been established. Record the actual tested versions below rather than inferring support from the manifest or Node tests.

## Physical observation — 2026-11-13

Release **v0.17.9** (source commit `b0bdb256ca90f10649edf5336f829ab2894d5fb6`) was installed on the existing Homey Pro installation. The user confirmed that **Energiöversikt is visible in the Dashboard widget picker and displays data**. Homey monitoring had been recorded on firmware 13.5.4; the Dashboard/mobile client version was not recorded. This establishes basic visibility and data rendering on this installation, not the full smoke test below.

The install preserved configuration, the Tibber token and all 34 previously closed history quarters. Fresh Sigenergy/Nibe reads and 192 cached price intervals were observed afterwards; hardware writes remained disabled. Private identifiers, addresses and usage values are omitted.

## Physical smoke test still required for issue #13

After review/merge, install the release preserving app data, then:

- [ ] Record Homey model/firmware and mobile app or Dashboard client/platform version.
- [ ] Find **Energy overview / Energiöversikt** in the app widget picker; add, remove and add it again.
- [ ] Verify initial loading, content height and refresh with populated and empty app data.
- [ ] Compare units, Stockholm history time, Nibe outdoor temperature and the configured tariff peak count with app settings; retain provisional/advisory labels.
- [ ] Check light/dark mode, narrow/wide layouts, larger text and screen-reader reading order. Local markup/status roles are not a screen-reader certification.
- [ ] Verify source-disabled, stale, failed and recovered states; confirm cached numbers disappear after API failure/timeout.
- [ ] Confirm the widget loads after an app/Homey restart and that removing it does not remove app settings/history.

Do not close [issue #13](https://github.com/Marza/homey-sigenergy/issues/13) until those physical checks are recorded. Publish only sanitized observations; keep credentials, network addresses and household screenshots private.
