# Backup advisory and future control gate

Hardware access remains read-only and learning mode is enforced. EV stop, Nibe economy/critical mode and auxiliary-heat blocking are requests only. `controlApplied: false` never acknowledges an action. A Flow consumer is responsible for any separate automation it implements; app tokens confirm no physical outcome.

## Current behavior

Startup/restart and changed device settings invalidate the previous backup decision. Unknown, off-grid, failed, disabled, stale or future-dated plant/backup observations block runtime charging previews and price plans with `backup-restricted` and no charging slots. Current cap/reserve recommendations are removed. Both a fresh usable plant source and a fresh on-grid decision with `suspendEconomicOptimization: false` are required to resume advice.

Register 30009 is interpreted as 0 = grid, 1/2 = island, otherwise unknown. Five minutes of continuously observed grid readings are required at startup and after loss/island state. A gap longer than the plant freshness limit or a backwards clock resets that delay. A reader restart starts a new delay. Low valid battery SoC (<25%) requests critical Nibe mode while restricted; invalid or stale SoC cannot establish critical mode. No EV stop, Nibe block or automatic restart is executed.

Backup decisions are published before optional battery/EVDC work. Settings events invalidate saved recommendations immediately; a minute timer checks freshness if polling stalls. Charging APIs and Dashboard projections check freshness at request time. Nibe policy is refreshed at transitions and at its next poll; policy timestamps do not imply a new temperature measurement. Existing Nibe tariff schedules remain authoritative; the app does not infer their active state.

Historical replay, tariff scenarios and observed demand estimates remain available. Replay results carry `historicalOnly: true` and current backup context. Settings label historical simulations and the Dashboard qualifies tariff scenarios. These are counterfactual historical calculations, not present dispatch instructions or guaranteed savings. Open browser views refresh periodically; a previously rendered result is not live permission to operate equipment.

## Validation scope

Automated fixtures cover startup, delayed restoration, interruption/gaps, invalid modes/SoC, stale/future/failed/disabled observations, API suppression, recommendation invalidation and advisory Flow tokens. Physical island transitions, actual EV/Nibe outcomes and fail-safe operation are unverified. Issue #15 must remain open until sanitized physical evidence is recorded after register verification (#3), including firmware, protocol revision, raw mode mapping, observation times and requested versus observed outcomes. Do not force an outage merely to complete software tests.

## Separate gate for any future control implementation

A separate reviewed proposal must specify:

- Vendor-verified interfaces, firmware/protocol versions, register widths/scaling and supported operations for each device.
- Explicit per-device opt-in, permissions, cancellation and visible control status, with learning/read-only defaults.
- Independent inverter, charger, electrical and Nibe frost/temperature protections that function without Homey, networking or this app.
- Command acknowledgements and independently observed outcomes, bounded timeouts, retries/idempotency and failure states; a request alone is never success.
- Communication loss, stale data, app/Homey reboot, partial execution and power/network recovery behavior. Restart must have an explicit, reviewed policy and must not blindly replay old commands.
- Controlled hardware validation, rollback and sanitized records covering all relevant transitions and low reserves.

This work introduces no control adapter, Modbus writes, mains switching or replacement of native protection.
