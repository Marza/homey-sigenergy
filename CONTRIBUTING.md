# Contributing

Contributions, bug reports and hardware register verification are welcome.

1. Open an issue describing the problem or enhancement.
2. Create a branch and make a focused change.
3. Run `npm test` and include tests for changed calculations.
4. Open a pull request with a description of safety implications.

## Safety

Keep Modbus operations read-only. Do not add writes to the inverter, battery,
EV charger or heat pump without documented registers, safety review, explicit
opt-in, and hardware validation. Never commit API tokens, private IPs,
credentials, exported history, or personally identifying telemetry.

## Hardware validation

Clearly distinguish simulated results from values measured on physical devices.
Do not claim hardware compatibility based solely on unit tests.

Source-status rules live in `lib/source-status.js`. After editing them, run `node scripts/sync-source-status.js` to update the packaged browser copies in settings and the widget. Tests reject copies that differ from the shared module.
