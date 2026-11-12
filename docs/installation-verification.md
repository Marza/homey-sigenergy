# Local installation verification

This records packaging checks for issue #2, not hardware compatibility or App Store certification.

## Toolchain

- Homey CLI: 4.6.3, pinned in `devDependencies` and `package-lock.json`.
- Development/CI: Node.js 24 and npm; install with `npm ci`.
- Manifest: Homey SDK 3, local platform, Homey firmware >=12.0.0. The validator requires 12.0.0 for the `battery` driver class. No physical firmware version has yet been tested.

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

The initial source failed debug validation because `author` was missing, the declared firmware minimum was too low for `battery`, and the app icon was absent. The manifest now identifies the existing maintainer, declares >=12.0.0, and includes original generic battery icons for app and driver. No driver IDs, capabilities, register maps or control behavior were changed.

Local results on 2026-11-12 (macOS, Node.js 24.22.3, npm 11.20.0, CLI 4.6.3): clean `npm ci`, all 74 tests, matching version checks, debug validation and the production-dependency build passed. The build contains the manifest, runtime, driver, settings, icons and Modbus dependency; tests, development docs and the CLI executable are excluded. The packaged Modbus dependency also loads locally. CI repeats that dependency-load check on Linux. These results do not establish installation or operation on Homey.

The widget remains a candidate tracked in issue #13. A successful app build does not establish widget registration, visibility or runtime behavior on Dashboard.

## Physical Homey smoke test — pending

No existing Homey CLI login was available in the verification environment. Do not mark issue #2 complete from CI alone. Run the following on a test Homey on the same LAN and record results against the exact commit:

- [ ] Record date, commit, computer OS, Node/npm/CLI versions, Homey model and exact firmware version. Keep tokens and network addresses private.
- [ ] Start Docker if required for local execution. Run `npx --no-install homey login`, then `npx --no-install homey select` and confirm the intended Homey.
- [ ] Run `npx --no-install homey app run`; record startup and settings-page behavior. Stopping this development session removes that instance.
- [ ] Run `npx --no-install homey app install` and verify that the app remains installed when the command exits. Avoid `--clean`, which deletes app data and paired devices.
- [ ] Pair the single Sigenergy plant, enter its verified LAN settings, confirm saved settings and device availability. Keep EVDC disabled until its separate register verification in issue #4.
- [ ] Check base capabilities against vendor readings using the verified profile from issue #3. If no validated hardware profile is available, record this part as pending rather than guessing registers.
- [ ] Restart the app and Homey; confirm paired device/settings persistence, polling recovery, UI loading and startup unknown/restoration advisory behavior.
- [ ] Observe an unavailable Modbus endpoint and recovery; confirm unavailable/error status, no misleading confirmed stop/control claim, and no writes. Native protections stay active.
- [ ] Uninstall the test app only after exporting any history you need; verify removal and record whether a reinstall starts as expected.
- [ ] Attach a sanitized result table with pass/fail/pending for each step, logs for failures, and the tested model/firmware. Update README only for observed configurations.

Do not enter production credentials in CI or public issues. Installation tests do not validate safety behavior, optional EVDC/Nibe profiles, tariff accuracy or automatic control. This build remains read-only.
