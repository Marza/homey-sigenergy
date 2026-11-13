# Dashboard widget validation

## Supported target and implementation

The app now declares **Homey >=12.3.0**, local platform only, following the [official widget requirements](https://apps.developer.homey.app/the-basics/widgets). This raises the earlier 12.0.0 minimum. Physical app monitoring has been tested on Homey Pro firmware 13.5.4; it does **not** establish widget compatibility at either version. Homey Cloud is outside the target.

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

The reported problem is on **iPhone/iPad touch input**; the Homey mobile-app and iOS/iPadOS versions have not been recorded. The app-side fix removes unnecessary internal scroll containers only when the full content fits the actual viewport. Genuine overflow remains scrollable if Homey constrains/rejects the requested height or a zoomed viewport is smaller.

`lib/widget-layout.js` (generated into the widget) measures the flow-root `#widget-content` wrapper, including padding. Initial `Homey.ready({height})` and subsequent `Homey.setHeight` use rounded content height with two CSS pixels of headroom. The fit check uses actual content height rather than requiring those extra pixels. A `ResizeObserver`, viewport/visual-viewport resize handlers and font readiness update layout without waiting for the next data poll. Requests are batched/deduplicated to avoid feedback loops, and failed sizing can be retried. Clipping is enabled only for a fitting document; unsupported `overflow: clip` falls back to `hidden` in that fitting case. Normal overflow is restored when content does not fit.

The widget keeps `overscroll-behavior: auto`. It does not cancel touch/wheel events, disable selection/pinch zoom, manipulate the parent document or invent a Homey gesture-forwarding API. [Homey's published view API](https://apps.developer.homey.app/the-basics/widgets#view-api) exposes sizing; native WebKit scroll views are part of the host application ([Apple documentation](https://developer.apple.com/documentation/webkit/wkwebview/scrollview)). The host/browser decides how gestures cross that boundary. An app-side sizing/overflow fix therefore cannot guarantee native Dashboard gesture transfer without testing the actual Homey client.

Local verification on 2026-11-13 used a synthetic Chrome iframe host: at a narrow 390-pixel viewport, scrolling over a fully fitted widget moved the parent by 900 pixels while the child stayed at zero with no internal overflow. Wider content (600 pixels), increased text size and empty data resized without inner overflow. In a deliberately constrained 250-pixel frame, overflow remained accessible through child scrolling and the parent stayed stationary. Unit tests cover rounding/exact fit, cached-height independence, content changes, batching, zoom, rejected/absent sizing APIs, legacy observer fallback and disposal.

This is browser/fixture evidence, **not an iPhone/iPad Homey-app acceptance result**. Keep #31 open until a release containing the fix is installed and touch scrolling is confirmed there; record the client/OS versions and verify populated/empty/error views, larger text, orientation changes, selection and zoom. If the native host still captures gestures, record that limitation for a Homey-side fix rather than adding global touch interception.
