# Backup advisory and future control gate

The economic planner and the backup Flow are advisory. EV stop, Nibe economy/critical mode and auxiliary-heat blocking are requests only. `controlApplied: false` never acknowledges an action. A Flow consumer is responsible for any separate automation it implements; app tokens confirm no physical outcome.

## Current behavior

Startup, a connection change and stale readings invalidate the previous backup decision.

Register 30009 is interpreted as 0 = grid, 1/2 = island, otherwise unknown. Five minutes of continuously observed grid readings are required at startup and after loss/island state. A gap longer than the plant freshness limit or a backwards clock resets that delay. A reader restart starts a new delay. Low valid battery SoC (<25%) requests critical Nibe mode while restricted; invalid or stale SoC cannot establish critical mode. The Flow does not actuate devices.

Backup decisions are published before optional battery and EVDC reads. The minute timer checks freshness. Nibe policy updates on transitions and on the next poll.

Household forecasts and observed demand estimates remain available in learning mode.

## Nibe production block

The optional interlock runs on Homey in the background. In **Inställningar → Anslutningar → Nibe SMO S40**, enable the outage option and save it against the intended controller. Use SMO S40 firmware 2.4.3 or later with Modbus enabled and address offset 0. Reserve the virtual Modbus AUX for Homey. Ensure the external heating-medium pump GP10 is wired and configured for circulation during blocking. **Diagnostik → Nibe vid ödrift** reports the most recent check. GP10 is a controller indication, not a flow sensor.

After at least five continuous minutes of actual island observations, Homey checks the interlock on its ten-second timer. Missing or unknown readings, a backwards clock or a restart reset the observation period. Homey reads AUX selection and state (holding registers 2740/2741) and heating-medium pump GP10 (input register 1066). It selects tariff block function 19 on an unused selector, or uses an inactive, dedicated selector already set to 19. An active or differently assigned AUX is left alone. Tariff blocking inhibits heating, domestic hot-water production, auxiliary heat and cooling. The controller stays powered. Homey does not write to a pump, temperature setpoint or operating schedule.

Homey reads back the block and GP10, then checks them every ten seconds. A stopped or unreadable pump causes release of the app's block. A manual release or failed activation inhibits further activation during the same island episode. A fresh on-grid observation, loss of usable grid status, disabling the option or a normal app shutdown also requests release. The economic planner's separate grid-restoration delay still applies to planning.

Homey records the original AUX selection and endpoint before writing. It retries an unconfirmed release at the original endpoint after a disconnect or restart. If Homey or the network loses power, Nibe may retain the block. To recover manually, disable the Homey option and check AUX on the SMO S40. If the dedicated selector is still 19 and active, release it by setting holding register 2741 to 0 through the verified Nibe connection. Check heating, hot water and GP10 on the controller. Extended blocking can cause freezing.

Register definitions and operating effects are documented in [NIBE S-Series Modbus, SMO S40 and AUX tables](https://www.nibe.eu/download/18.42a6470a1963dded290bb1/1746538843623/Technical%20information%20Modbus%20S-Series.pdf) and the [SMO S40 installer manual, external blocking](https://assetstore.nibe.se/hcms/v2.3/entity/document/877311/storage/ODc3MzExLzAvbWFzdGVy).

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

The scoped Nibe adapter above is the only control path.
