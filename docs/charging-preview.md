# Read-only charging-plan preview

The app settings can request an authenticated **POST `/charging/preview`** dry run. The handler reads saved charging configuration and the existing validated Tibber cache. It does not save inputs, fetch prices, change device settings or send charging commands. The installed/released app and the preview development branch are separate; review and merge the preview before deploying it.

## Explicit inputs

- **Vehicle SoC:** manually read, finite 0–100%, with an explicit observation timestamp. The observation must be at most 15 minutes old and cannot be future-dated. The UI accepts the browser/device's local wall time and sends an ISO instant; displayed plan times use the saved charging timezone. The stamp button sets a time only when explicitly pressed. Do not press it to pretend an older SoC reading is new.
- **Connection:** the checkbox assumes continuous connection throughout the 48-hour model window. It is not an observation of a connected vehicle. An unchecked box produces `not-connected` with no schedule. There is no departure/arrival availability model.
- **Available power:** user-assumed, finite 0–350 kW, capped by the saved maximum. Zero produces `no-power`. This is not measured household headroom, phase balancing or fuse protection; Homey does not enforce it.
- **Saved configuration:** minimum SoC/time, enabled daily targets, timezone, usable battery capacity, constant efficiency and maximum charging power. Save edits before requesting a new preview. Validation rejects missing/nonfinite inputs and bounds usable capacity to 1,000 kWh and power to 350 kW as input sanity limits, not hardware ratings.

EVDC is not used as an automatic SoC source until its profile is verified under issue #4. The first implementation deliberately supports the explicit manual alternative. No physical charger or charging efficiency has been calibrated by the preview tests.

## Result and limitations

The result identifies manual SoC/time/age, continuous-connection and no-driving assumptions, effective power, capacity, efficiency, timezone, 48-hour planning horizon and available price horizon/fetch time. It lists SoC deadlines with price coverage/gaps and missing battery energy, plus the selected price windows and allocated **input kWh**. A partially allocated price window does not mean the car charges for that entire window; no exact on/off dispatch is produced.

Energy is accumulated without driving, idle losses or battery discharge between targets. The model uses constant power and efficiency, and no solar/household/home-battery dispatch. Higher targets once reached are assumed retained; it does not model a commute after a deadline. Separate solar allocation and its illustrative efficiency curves remain outside this preview.

Cost is the sum over selected known-price input energy using **Tibber's consumption `total` in SEK**. It is not full marginal electricity cost, export compensation, verified savings or a bill. Grid charges, demand fees, export opportunity cost and battery wear are not included. Missing prices are never zero, and negative known prices remain negative. Partial-price results describe only the available intervals and cannot establish a globally cheapest complete plan.

Statuses include `planned`, `partial-prices`, `unreachable`, `already-met`, `no-prices`, `not-connected` and `no-power`. Missing prices can also cause unreachable energy targets; coverage and unmet-energy fields remain separate. Already-met targets require no energy even without prices, under the explicit no-driving/discharge assumption. No price/connection/power result implies hardware enforcement.

The UI clears previous results on input/schema edits, failures, a ten-second request timeout and expiry of the manual SoC observation. Late replies from earlier requests cannot restore them. The preview is a snapshot at its displayed creation time, not an automatically executing or continuously refreshed plan.

## Time and DST

A deadline is resolved once per local calendar date in the saved timezone (default Europe/Stockholm). In a spring clock gap, a nonexistent wall time advances to the first valid local minute after it; a repeated autumn time uses its **first occurrence**. Adjusted deadlines are marked in the result/UI. Deadlines already passed at calculation time are not recreated for the second autumn occurrence. Month/year boundaries use actual UTC instants. The horizon is bounded to at most 48 hours; input prices are limited to 512 intervals and checked for overlap.

## Verification

Tests cover explicit/manual/stale/future SoC, finite/bounded configuration and power, disconnection, zero power, no/partial/negative prices, already-met and unreachable targets, spring/fall transitions, year boundaries, authenticated runtime delegation without writes or credential leakage, and browser request/result invalidation. The browser configuration validator is an exact generated copy of the shared planner.

These checks do not establish physical charging behavior or guarantee that the manually entered SoC, efficiency, available power or connection assumptions are true. Learning mode and read-only hardware access remain in place.
