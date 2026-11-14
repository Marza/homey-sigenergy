# Coupled solar, home-battery and EV replay

The optional **Jämför solfördelning** mode in the economic comparison section replays a historical solar/load window with one explicitly hypothetical EV charging task. It compares home-first and EV-first solar priorities using the dated terms, hourly trade prices and demand calculation already used by the balanced battery comparison. It issues no commands and makes no forecast or automatic economic ranking.

## Setup and honest scope

1. Save/check the existing cost and demand-tariff drafts, publish dated terms, and confirm the existing Tibber home as for the battery-only comparison.
2. Select the latest 1–168 closed hours and up to ten distinct import caps. Enter/check the home-battery assumptions and its upper solar-storage target. The target must be between the initial energy and capacity; it is a maximum charging target, not a promise that the sun can fill it.
3. Enable the coupled mode. The backend uses the **saved** EV usable capacity, charging efficiency and maximum charging power from the existing charging configuration. Enter a hypothetical initial SoC, target SoC, min/max active charging power, arrival and departure in quarter-hour steps relative to the selected historical window. The target must meet the saved minimum SoC. User maximum power can lower, but cannot exceed, the saved maximum.
4. Explicitly confirm that these are historical modeling assumptions and that the selected history contains neither existing EV charging nor discharge from the vehicle. The window must have complete independent PV coverage. A known nonzero EV integral or EV power observation blocks the mode even if the owner checked the box; this prevents adding the same charging twice.

No EV SoC, actual plug state, earlier driving or presence is reconstructed. Missing EV observations do not prove absence: owner confirmation is required. The initial/target SoC is not a fresh real-time measurement and is not copied from experimental EVDC telemetry. The model task is separate from the configured daily departure schedule; it reuses capacity/efficiency/power limits, not an inferred historical daily schedule. Windows containing existing vehicle charging/discharging require a separately verified EV-load subtraction source before this mode can support them.

Exactly one currently paired Sigenergy parent is required; companions do not count as additional plants. This does not prove historical source identity or undo mixed/imported history. The PV series is the selected own/third-party/combined solar source recorded at the time. It is not automatically corrected for later selection changes or proven to cover all inverters. Confirm that the chosen history and common AC measurement-boundary assumptions are meaningful for the installation. A negative inferred non-EV household load is rejected as an inconsistent boundary; the app cannot establish calibration from nonnegative values alone.

## Shared physical model

The backend reconstructs residual load as `gridWh - essWh`, removing the already-observed home-battery action once. It uses independently covered selected `pvWh` to distinguish the modeled household and solar flows. All strategies and the reference receive identical residual load, PV, EV target, arrival/departure and initial battery energy.

The reference charges the EV as early as possible in its availability window, at the bounded active power, with a passive home battery. It is an explicit modeling reference, not the actual meter bill or an optimal charging policy.

Candidates prioritize either home charging or EV charging from surplus PV, after household consumption and mandatory EV charging are accounted for. The home battery can store solar above its initial state up to its target. Extra stored energy is used against later positive load; cap-shaving respects reserve, power and efficiency. Grid recharge can restore previously depleted initial energy only within modeled cap headroom. Every recharge appears in the grid balance and its cost; there is no free solar/recharge bucket.

EV charging waits for usable surplus when possible. A latest-start calculation requires enough charging in the current quarter when future maximum power could no longer meet the departure target. This can require non-solar supply and can make the chosen **soft** import cap unachievable; uncovered cap energy is shown. The model does not enforce a physical connection/fuse or perform phase switching. EV minimum active power is respected. If the EV reaches its target part-way through a quarter, the remaining portion is dispatched separately. Import before that stop and export afterwards are recorded separately rather than pricing only the net quarter.

Each candidate tracks home charge/discharge/loss, EV input/stored energy/loss, remaining target, home state and directional grid import/export. Conservation checks cover:

- home AC charge minus discharge and losses equals its stored-energy change;
- EV input minus charging losses equals added EV stored energy;
- selected PV equals direct modeled household use, direct EV input, home-battery charge input and remaining solar export;
- grid energy equals the common residual load plus EV input plus home charge minus discharge.

“Direct solar to EV” is charging input before EV losses. Solar previously stored in the home battery and later supplied to the EV is not relabeled as direct solar. The EV’s other supply can include grid and home-battery discharge; no unsupported source attribution is invented.

## Equal goals before comparing costs

Both reference and candidate must meet the same EV stored-energy target by the same departure. The home battery must end at its initial energy, as in the balanced battery-only model. If either goal is not reached, component results can be displayed but the total cost difference is null. Excess energy left in storage is not assigned an invented terminal value or forced sale, and depleted energy is not called a saving.

The common pricing helpers apply the same hourly prices, dated tax/grid/export terms, AC-discharge wear and preliminary demand tariff to every strategy. Negative prices and the opportunity cost of reduced export remain explicit. Missing prices/contracts/coverage, insufficient tariff peaks and within-month tariff changes retain the existing blocking behavior. There is no separately guessed solar value or use of the standalone allocator’s illustrative efficiency curves.

Historical effective hourly prices can depend on actual meter flows; adding/moving a hypothetical EV or battery changes those flows. Costs are therefore **indicative**, with `financiallyComparable: false`, `rankingBasis: none` and `controlApplied: false`. Candidates stay in cap/priority order, without a “best” dispatch instruction. The result is not a future solar forecast, live control recommendation, bill, guaranteed saving or phase/fuse safety calculation. The earlier short live solar-surplus preview and charging-plan preview remain independent.

## History version 6 and migration

New power integrations record `fieldCoverageMs` for `gridW`, `pvW`, `essW` and `evW` independently. It can be less than older net/ESS coverage in an upgrade quarter: old duration is not borrowed. The new coupled mode requires a closed quarter with full PV coverage as well as the existing complete grid/directional/ESS coverage. The battery-only replay can continue using its existing ESS coverage without the new PV field.

History exports use version **6** to carry this metadata. Valid versions 1–5 remain accepted, with absent power coverage remaining absent. Stored state/daily schema 3 and quarter schema 2 are unchanged. Keep a pre-upgrade backup for downgrade; earlier apps cannot restore version-6 exports. The combined history/meter backup remains wrapper schema 1, and dated cost terms retain their separate export. No old PV coverage, generation, EV usage or source calibration is backfilled.

## API and verification

Authenticated POST `/economics/solar-ev-replay` reads local snapshots only. It shares context and cost evaluation with the battery replay and has no settings writes, network fetch or hardware access. Requests are bounded to seven days, ten caps and two priorities; the engine has a bounded number of subsegments per quarter.

Synthetic tests cover different priorities, scarce PV, same goals, min/max power, fractional charging completion with both import/export, arrival/departure, impossible goals, stored-energy excess/depletion, negative payouts, non-solar supply, conservation, missing/legacy PV coverage, known EV-load exclusion, source/config validation, export/restore and late/error UI responses. Browser checks exercise the full coupled form and real synthetic backend at narrow/wide light/dark layouts. These do not certify real EV capability, AC/DC boundaries, actual billing semantics or native Homey mobile-client behavior. Owner verification remains necessary after review/release/installation.
