# Local installation verification

This records packaging checks and limited physical installation tests for issue #2, not a general hardware compatibility certification or App Store approval.

## Toolchain

- Homey CLI: 4.6.3, pinned in `devDependencies` and `package-lock.json`.
- Development/CI: Node.js 24 and npm; install with `npm ci`.
- Manifest: Homey SDK 3, local platform, Homey firmware >=12.0.0. The validator requires 12.0.0 for the `battery` driver class. Physical installation/polling has been tested on Homey firmware 13.5.4; the declared 12.0.0 minimum has not been physically tested.

Use `npx --no-install homey ...` after `npm ci` to use the pinned CLI rather than a different global version. The SDK runtime's `require('homey')` is supplied by Homey; the development dependency is the CLI.

## Reproducible checks

```sh
npm ci --no-audit --no-fund
npm test
npm run check:versions
npm run validate
npm run build:homey
```

`validate` runs `homey app validate --level debug`. `build:homey` creates `.homeybuild/`, copies production dependencies and validates at the debug level. Neither command requires an account or installs on a Homey. Generated output must not be committed. This is development validation; publish-level checks and App Store assets/certification are outside this change.

The initial source failed debug validation because `author` was missing, the declared firmware minimum was too low for `battery`, and the app icon was absent. The manifest now identifies the existing maintainer, declares >=12.0.0, and includes original generic battery icons for app and driver. Driver IDs, capabilities and register maps are unchanged. Follow-up fixes complete pairing navigation and apply incoming connection settings correctly; hardware access remains read-only.

Local results on 2026-11-12 (macOS, Node.js 24.22.3, npm 11.20.0, CLI 4.6.3): clean `npm ci`, all 74 tests, matching version checks, debug validation and the production-dependency build passed. The build contains the manifest, runtime, driver, settings, icons and Modbus dependency; tests, development docs and the CLI executable are excluded. The packaged Modbus dependency also loads locally. CI repeats that dependency-load check on Linux. These automated/local build checks alone do not establish installation or operation on Homey; the separate physical observations below provide the limited evidence collected.

The widget remains a candidate tracked in issue #13. A successful app build does not establish widget registration, visibility or runtime behavior on Dashboard.

## Physical verification — 2026-11-13

Tested code: [c505d5e](https://github.com/Marza/homey-sigenergy/commit/c505d5ead984b1d17a0530d1db9e331f7dec4ab5) in PR #17, app version 0.17.0. One physical Homey Pro (local platform, platform version 2) running **Homey firmware 13.5.4** was tested. The test computer ran macOS, Node.js 26.12.0, npm 11.20.0 and Homey CLI 4.6.3. The earlier reproducible CI/toolchain checks used Node.js 24.22.3.

The exact inverter/battery firmware and an authoritative vendor register revision were **not recorded**. These observations establish basic operation on this installation, not a general register-profile certification or support for all Homey/Sigenergy firmware.

| Check | Result | Evidence and limits |
| --- | --- | --- |
| Development-package installation | Pass | CLI reported successful installation; Homey API reported version 0.17.0 running and not crashed after the CLI exited. |
| Device pairing | Pass after fix | Initial list had no next/add step. Adding navigation to the standard add_devices view allowed the user to create the Sigenergy plant; the device was subsequently visible through the Homey API. |
| Settings persisted | Pass | Custom LAN host, port 502, unit ID 247, address offset 0 and EVDC disabled were retained after the Homey reboot. Host and device/account identifiers are intentionally omitted. |
| Apply changed connection settings | Fixed; automated regression passed | onSettings previously rebuilt the reader from old getSettings() values. The fix passes incoming newSettings explicitly. App restart recovered the saved host during troubleshooting. A mocked regression verifies changed host, port, unit ID and polling interval; a separate live change-after-fix test without restarting was not isolated. |
| Basic Sigenergy reads | Pass on this installation | Unit ID 1 returned Illegal data address. After the user changed it to 247, the device became available with no error and received SoC, capacity, grid, ESS and PV values. |
| Comparison with mySigen | User confirmed | The user confirmed those base readings and power directions matched mySigen. No precision study, independent meter calibration, or export/charge state sweep was performed. Private live usage values are not published. |
| App restart | Pass for reconnect/startup | Restart command completed; saved host was used and Modbus responses resumed. Full backup-state transition behavior was not tested. |
| Physical Homey restart | Pass for persistence and polling recovery | The user restarted Homey. Afterwards the API reported the app running, device available, saved settings unchanged and fresh power readings. A successful plant snapshot was recorded at 13:54:25 Europe/Stockholm (12:54:25 UTC). |
| Read-only operation mode | Pass for reported state and source boundary | operationMode returned learning with allowHardwareWrites:false before/after testing and after reboot. Source contains no Modbus write path; no packet-level audit was performed. |
| Connection-error recovery | Partially observed | Initial unreachable example host became a responding endpoint after correcting settings/restarting. Wrong unit ID produced a protocol exception; unit 247 recovered. A controlled disconnect/reconnect test was not performed. |

## Nibe SMO S40 verification — 2026-11-13

On the same Homey Pro installation (Homey firmware 13.5.4), the user enabled Modbus on the Nibe SMO S40. A subsequent read of the app's status through the Homey API showed a successful temperature snapshot and `nibeError: null`. The observed snapshot was timestamped 20:39:10 Europe/Stockholm (19:39:10 UTC). The installed app version was confirmed as **0.17.4**; this test does not imply that later merged releases had been installed.

The user explicitly confirmed that all four temperatures matched the Nibe display:

| Reading | Register used by the app | Comparison |
| --- | --- | --- |
| BT1 / outdoor | Input register 1 | User confirmed against display |
| BT7 / hot water | Input register 8 | User confirmed against display |
| BT25 / supply | Input register 39 | User confirmed against display |
| BT71 / return | Input register 88 | User confirmed against display |

The working configuration used Modbus TCP port **502**, unit ID **1**, and address offset **0**. Each field was read as one signed 16-bit input register, divided by **10** to obtain degrees Celsius. The connection had previously been refused before Modbus was enabled; reads succeeded after activation. Private network addresses, identifiers and live temperature values are omitted from this public record.

The app reported `controlApplied: false` in both the Nibe status and its advisory policy. Only reads were exercised; no Nibe writes, schedule changes or protection changes were performed. The display comparison establishes basic register mapping and plausible temperature readings on this installation, not independent sensor calibration or compatibility with every SMO S40 configuration.

The exact Nibe firmware and vendor register-export/protocol revision were not recorded. Missing-sensor and unsupported-register behavior, controlled communication loss/recovery, and long-term operation still need hardware validation under [issue #4](https://github.com/Marza/homey-sigenergy/issues/4). EVDC was not exercised by this test and remains unverified.

## Remaining smoke tests and validation limits

- [ ] Test the Docker-backed `homey app run` lifecycle separately. Testing used persistent installation and direct Homey API checks; Docker-run behavior is unverified.
- [ ] Verify another live host/port/unit-ID edit is applied without restarting, following the settings fix; retain the automated regression test.
- [ ] Test controlled communication loss/recovery and unknown/restoration advisory timing. Do not treat a grid-mode value alone as verification of island operation.
- [ ] Check the full settings/diagnostics UI after restart. Pairing and advanced-settings UI were exercised; all tabs and browser/device layouts were not systematically verified.
- [ ] Test uninstall/reinstall only after exporting required history. It was deliberately not performed on the active installation; data-loss/reinstall semantics remain unverified.
- [ ] Record exact Sigenergy hardware/firmware and validate the register profile under issue #3. Optional battery fields and grid/island mapping remain outside the basic reading comparison.
- [ ] Complete EVDC/Nibe validation under issue #4. Basic Nibe reads and all four display comparisons passed as recorded above; firmware/protocol evidence and error-case testing remain. EVDC remained disabled and was not hardware-validated.
- [ ] Validate Dashboard under issue #13, and history, tariffs, pricing and optimization under their respective issues. No financial/safety accuracy is established by this smoke test.

Issue #2 remains open for the outstanding smoke tests. Do not mark it complete from CI or this limited installation test alone.

## Installation notes

Use the ordinary `npx --no-install homey app install` flow with the pinned CLI. In CLI 4.6.3, `app install --skip-build` packs the source directory rather than the verified .homeybuild directory, so it is not interchangeable with installing a previously built production-only bundle. An initial installation using that flag was replaced with a validated build-directory bundle. Local packaging was slow; installation was completed through the same CLI install function, reusing the already validated build directory and preserving app data.

Do not publish credentials, network addresses, account/device identifiers or identifiable usage telemetry with test evidence. Keep native protections active. No hardware writes, automatic charging or Nibe control were enabled.
