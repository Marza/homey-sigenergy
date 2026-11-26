# Dashboard widget validation

## Supported target and implementation

The widget requires **Homey >=12.3.0**, local platform only, following the [official widget requirements](https://apps.developer.homey.app/the-basics/widgets). The app minimum is now **>=12.4.5** for native Energy counter mappings; the earlier widget work raised it from 12.0.0 to 12.3.0. Physical app monitoring has been tested on Homey Pro firmware 13.5.4; it does **not** establish widget compatibility at either version. Homey Cloud is outside the target.

This repository does not use Homey Compose. Merely including `widget.compose.json` did not register the widget in `app.json`; the widget is now explicitly registered there as `energy-overview`. Tests compare both definitions. The former numeric height of 2 would mean pixels, not grid rows. It is removed, and the widget reports the rounded intrinsic height of its content wrapper at initial readiness and on subsequent content/viewport/font changes, including error states. Body/viewport height is not reused as content height.

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

## Scroll handling — issue #31

On iPhone/iPad the Dashboard could continue scrolling across Energy Overview, but a fresh swipe starting inside the widget from rest could be captured. When the entire overview fits, its root now uses `overflow: hidden` on **both** axes. WebKit checks both scrollbar modes when deciding whether a view can rubber-band. Native gesture handling ultimately belongs to the Homey client. [WebKit viewport scrollability](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/LocalFrameView.cpp) · [Homey widget view API](https://apps.developer.homey.app/the-basics/widgets#view-api)

The layout helper measures `#widget-content` including its padding. It requests the rounded height plus two CSS pixels via `Homey.ready` and `Homey.setHeight`. Content, fonts and viewport changes trigger a fit check. A constrained frame, horizontally overflowing content or an active pinch zoom keeps native panning available. The overview leaves touch events and scroll chaining to the browser so users can tap the peak details and select text.

The browser regression test starts a touchscreen swipe inside a stationary, phone-sized Dashboard fixture. It checks that the Dashboard moves while the fitted widget stays at zero, and that a height-constrained widget scrolls internally. For [issue #31](https://github.com/Marza/homey-sigenergy/issues/31), repeat the first swipe on a physical iPhone/iPad in Homey Dashboard after installing the release. Also tap the peak details, let the widget resize and repeat the swipe. Record the Homey app and OS versions with the result.

## Meter-based energy flows

The V2.9 statistics profile reads plant unit 247, function 04, registers 30228–30271 in a single request on each configured plant poll (10 seconds by default). Each four-word unsigned counter has a resolution of 0.01 kWh. In order, they cover common household load, AC charging, own PV, third-party PV, battery charge and discharge, DC vehicle charge and discharge, grid import and export, and generator output. The flow balance includes both PV counters. The selected PV source still determines which value the native solar device publishes. The plant also reads general load power from 30282 (signed W) for Diagnostics. Grid, PV, battery and both chargers retain their existing power readers.

For each accepted pair of reads, the widget model allocates the smaller of total input and output in proportion to each source and each load. It sums those estimates after allocation. Energy without a matching source or use remains visible in the details. If the same battery, DC charger or grid connection moved energy in both directions in one interval, both sets of totals advance and all links for that interval stay unallocated. The counters measure directional totals. The bands express an accounting assumption where multiple sources and loads overlap. Conversion losses, register quantization and differences in measurement boundaries can produce residuals.

The widget shows the percentage of elapsed time with complete meter intervals, including a partially measured day. Minimum setup is the V2.9 statistics profile on the paired plant device. The plant counters include both EV inputs independently of the optional individual charger power readers. Matching plant-counter snapshots up to 15 minutes apart can recover directional totals across read failures or restarts. An interruption or a delay exceeding 1.5 poll intervals (15 seconds at the default cadence, capped at 90 seconds) leaves the recovered source-to-load links unallocated. Invalid counters, resets, implausible changes and source changes interrupt continuity. Firmware supporting only individual counters can still supply the older quarter-history view. Historical counter totals alone cannot reconstruct earlier links. See the [manufacturer’s Modbus V2.9 table 5-1](https://github.com/TypQxQ/Sigenergy-Local-Modbus/blob/main/Modbus_reference_documentation/Sigenergy%20Modbus%20Protocol%20EN_V2.9.pdf).
