# Native Homey Energy reporting — first implementation for #37

## Scope and data boundary

This adds **opt-in, power-only** native Energy devices. It does not replace the existing Sigenergy plant device or the custom Dashboard widget. Native Energy visibility and whole-house totals still require physical validation; keep [issue #37](https://github.com/Marza/homey-sigenergy/issues/37) open.

The [Homey Energy SDK](https://apps.developer.homey.app/the-basics/devices/energy) distinguishes grid metering, solar generation and home batteries. This implementation uses three separate driver roles with standard `measure_power` values, following those roles:

| Optional device | Class / Energy role | Source and sign |
| --- | --- | --- |
| Sigenergy Energy — grid | `sensor`, `cumulative: true` | Existing `gridW`: positive import, negative export; never a derived house-load value |
| Sigenergy Energy — solar | `solarpanel` | Existing `pvW`: positive solar generation; negative/invalid PV values are unavailable |
| Sigenergy Energy — battery | `battery`, `homeBattery: true` | Existing `essW`: positive charging, negative discharging; valid SoC is published separately |

The original plant retains its device ID, class, capabilities, connection settings and history. No existing pairing is removed or replaced. No Energy companion is created automatically. Each companion points to its selected existing plant using that plant's pairing-data ID and only reads the parent's live in-memory snapshot. It opens no Modbus connection, adds no register reads and has no command capabilities or listeners. The current native support is **W and battery % only**; no `target_power`, switching, writable battery state or native scheduling is introduced.

Homey can use the selected grid/solar/battery roles to form its native energy overview. We do **not** publish `gridW + pvW - essW` as another whole-house meter: doing so would invite duplicate accounting. The existing plant readings were compared against mySigen on one installation, but their AC/DC measurement boundaries, conversion losses, sampling alignment and every import/export/charge/island state are not independently verified. Direct reporting of these readings therefore does not establish calibrated AC house consumption. Physical comparison of the resulting native flows is a required follow-up.

## Setup after merge, release and installation

1. Keep the existing configured Sigenergy plant device. Check that it is receiving fresh data.
2. In Homey's add-device flow for this app, select **Sigenergy Energy — grid**, **solar** or **battery** and select the parent plant. Each role can be added separately; already-paired parents are omitted for that role. Add only the roles not already reported by another integration.
3. If a P1 meter/Homey Energy Dongle/Tibber meter already supplies grid exchange, retain one authoritative grid source. Likewise choose one solar source and one battery source. This app does not inspect other apps or automatically decide which source is authoritative.
4. Use Homey's native **Exclude from Energy** setting to exclude duplicates. The grid device's native **Tracks total home energy consumption** setting determines its main-meter role. Check native settings before relying on the overview. See the [official Energy settings documentation](https://apps.developer.homey.app/the-basics/devices/energy#settings).
5. Each companion also has an app setting to disable live publication. Disabling clears its current values and marks it unavailable; it does not erase prior Energy history or guarantee that the native UI hides its tile. Remove only an unwanted companion if appropriate; the original plant stays paired.

The SDK driver manager resolves the existing source through [`getDriver`](https://apps-sdk-v3.developer.homey.app/ManagerDrivers.html#getDriver) and [`getDevices`](https://apps-sdk-v3.developer.homey.app/Driver.html#getDevices). Startup order is handled by retrying lookup; the companion never starts a replacement plant reader.

## Freshness and lifecycle

Companions refresh every five seconds, using the existing poll's timestamp and a freshness limit of at least 30 seconds or three configured poll intervals. Thus loss/staleness is reflected by the next companion refresh, not instantaneously. A failed or replaced parent reader clears its snapshot. Source removal, startup without a snapshot, invalid/future/stale timestamps and disabled publication yield unavailable/null, not a fabricated zero. Real measured zero remains zero. Grid reporting is unavailable for island/unknown grid mode; solar and battery may still show independently valid source measurements.

A software plausibility bound rejects power magnitudes above 10 MW; it is not a verified inverter rating. Invalid battery SoC is cleared without inventing a percentage. Capability-write failure attempts to clear readings and mark the companion unavailable. Only one refresh is in flight; source generation, disable and shutdown changes are rechecked around asynchronous writes so old results cannot mark the companion available again. A later refresh can recover. If Homey itself rejects a clearing write, the companion is still marked unavailable where possible; this is not a guarantee about how every native client renders stale cached values.

## Why there are no kWh capabilities yet

The current reader has no verified cumulative import/export/solar or battery charge/discharge energy registers. A current-month Tibber snapshot and 32-day integrated inverter history are not lifetime meters. This PR does not invent counters, reset daily totals into `meter_power` or replay hourly backfill as a live cumulative meter. Consequently native daily/monthly energy totals or features requiring separate imported/exported kWh may remain absent. Reproducible vendor register/firmware evidence and counter-reset behavior are prerequisites for adding those capabilities; no authoritative counter mapping was established during this implementation.

## Verification and remaining acceptance

Automated fixtures cover manifest roles/pairing, source selection, signs and zero, invalid/stale/off-grid data, disable/re-enable, missing/removed sources, restart/stop, failed writes, serialized refresh and replacement during an in-flight write. Parent lifecycle tests verify that the shared source clears on communication loss/reconfiguration/shutdown. Homey debug build validation checks the new drivers; release checks must retain their runtime files/icons.

After review and release, record actual Homey firmware and mobile-client version, add the desired companions, inspect native Energy visibility and compare simultaneous readings/directions with mySigen. Check existing-meter exclusion, battery charging/discharging, solar/self-consumption/export, controlled connection loss and recovery, app/Homey restart and companion removal. Native screen behavior and AC balance remain unverified until those observations are recorded. Publish only sanitized evidence. No physical inverter/counter verification is implied by Node tests or a successful build.
