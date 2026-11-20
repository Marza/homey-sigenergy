# Dated cost terms and balanced battery comparison

This read-only feature connects dated cost/tariff snapshots, a conservative battery replay and an indicative economic comparison. It uses the existing Tibber GraphQL connection and collected history. It does not enable control, replace the legacy demand-only recommendations or establish a calibrated household model.

## Publish terms with an explicit start date

1. Save the cost underlay and demand tariff using their existing forms. They remain drafts for this feature.
2. In **Ekonomisk jämförelse – historisk modell**, enter the actual **Gäller från** date in Europe/Stockholm. `Kontrollerat datum` is not an effective date and is never used for automatic migration/backdating.
3. Confirm the effective date and the meaning of the reported Tibber prices. If selecting separate network components, confirm that tax, grid import fee and export benefit/fee are not already included in the reported trade prices. Supplier additions are not automatically added again. A separately billed component that is not represented by these inputs prevents claiming complete billing costs.
4. Publish the dated copy. It freezes the validated cost contract and the selected demand tariff, including its season/calendar, peak count and rate. New versions must have increasing start dates. A version applies from local midnight, inclusive, until the next version starts, exclusive. A future version does not change prior hours' rates. Before the first version, terms remain unknown.

The `costContractTimeline` setting holds at most 100 versions/256 KiB. Each ID hashes the normalized snapshot and its provenance; this detects inconsistencies, not authenticity or signature verification. Existing versions cannot be edited/deleted through these endpoints. Publication compares the loaded archive revision and saved-draft hash to avoid racing a form edit or another publication. Writes must be read back before reporting success.

There is no automatic dated copy of existing undated terms. After upgrade, the old “include network” mode requests a dated underlay instead of applying current additions to all historical hours. Once a timeline exists, the observed-cost ledger uses each hour's dated snapshot and reports missing-contract hours. Editing the old cost form no longer changes already published terms or their historical calculations. An empty timeline with trade-only mode can still display the existing reported-price reference.

## Back up the cost archive separately

The new section exports/restores only the dated cost archive. It contains user-supplied contract source text and financial assumptions, so keep it private. No credentials, Home IDs, connection settings or controls are included. The regular combined inverter/meter-history backup does **not** include this setting.

Restore requires explicit confirmation of the same installation and the expected current archive revision. It validates the entire file before writing, is idempotent for identical versions, and rejects conflicting versions or inserted boundaries that would change an already published interval. A restored archive is user-supplied evidence, not verification that the rates match the installation's contracts.

## Battery coverage and history compatibility

New ESS integrations record `essCoverageMs` independently from grid coverage. The battery replay requires every selected, closed quarter to have full grid coverage, full directional import/export coverage, and full ESS coverage with finite consistent energy values. Missing legacy ESS coverage is never inferred from observation counts, net coverage or a finite `essWh`. Historical data remains intact; only newly covered quarters qualify. A quarter spanning the upgrade or a restart/outage may remain partial.

History exports now use **version 6**, carrying independent `fieldCoverageMs`; version 5 introduced optional quarter-level `essCoverageMs`. Stored state/daily schema 3 and quarter schema 2 remain compatible. Valid exports 1–5 are still accepted; they do not acquire missing battery coverage. Version 4 and earlier cannot carry this field. Keep a pre-upgrade history backup for downgrade: older app versions cannot restore a version-6 export. Ordinary combined backups remain wrapper schema 1, with a version-6 `history` member. Cost terms still use their separate export.

## Shared battery model and energy balance

Choose the latest 1–768 closed UTC-aligned hours (shown in Stockholm time), up to 20 distinct caps, and explicit manual battery assumptions: capacity, initial stored energy, reserve, charge/discharge power and charge/discharge efficiency. Saved optimizer values may prefill the form; they are not automatic proof of historical battery capability. Confirm the common AC measurement-boundary and constant-within-quarter assumptions.

For each full quarter, the model reconstructs residual net load as `(gridWh - essWh) / 1000`, following the existing positive-ESS-means-charging convention. This residual includes household/EV consumption and solar effects; it is not a separately calibrated house-load measurement. Removing the observed battery avoids counting its action twice. The **baseline has no active battery**, preserves the supplied initial stored energy and uses that residual net load. It is not the actual metered bill or the observed battery strategy.

Each candidate uses the exact same load series and starting battery state. It discharges only above the selected import cap, bounded by reserve, power and efficiency. Otherwise it recharges only previously depleted energy, using diverted export and/or real grid headroom below the cap. Charge and discharge are mutually exclusive within a model quarter. Every recharge changes import/export, and all conversion losses are accounted for. The model checks:

`AC charge − AC discharge − conversion losses = final stored energy − initial stored energy`

Returned energy and state boundaries remain explicit. A candidate that cannot restore its initial energy by the end has no total cost difference: extra depletion is never assigned a cheap residual value. Unshaved energy is shown; a cap need not be achievable with the assumed battery. This is a deterministic cap/recharge model, not an optimal arbitrage or solar forecast planner.

The residual and simulated grid flow are assumed constant inside each quarter. Directional import/export therefore come from modeled signed flow, and actual within-quarter opposing flows cannot be reconstructed. This assumption, AC/DC boundary uncertainty, manual capacity/efficiency and sampled integration prevent claiming hardware-verified savings.

## Cost components and comparison limits

Both baseline and candidates use identical intervals, hourly price rows and dated contracts. The comparison reports import/export quantities, purchase cost, export revenue, net energy cost, AC-discharge wear and preliminary demand cost separately. Network additions use the dated purchase VAT rate only on explicitly separate tax/grid additions. The reported purchase and production prices are not multiplied by VAT again. Negative prices are preserved. Fixed fees and rewards are excluded.

Demand uses directional modeled import for the same complete clock hours in each scenario, then applies each month’s stored tariff rules. Missing qualifying peaks block the total comparison, except that a configured inactive month or an explicitly zero demand rate contributes zero. Coverage reports remaining/missing hours, and partial-window demand costs are provisional observed-window estimates. If the dated demand tariff changes within a selected calendar month, the model blocks that month's comparison rather than inventing a prorated charge. Different energy-fee versions with the same demand tariff can still apply within the month.

A total and `indicativeNetDifferenceSek` are returned only when all intervals have prices/terms, the energy boundary matches, and demand costs are available for both scenarios. Otherwise component results may be shown with an explicit reason and a null difference. Periods are never silently shortened to the priced subset.

[Tibber GraphQL history](https://developer.tibber.com/api/reference.md) exposes production history at hourly resolution and reports effective `unitPrice`/VAT amounts. Such a price can depend on the actual within-hour meter pattern. Applying it to changed simulated flows is an **indicative historical model comparison**, not verified counterfactual settlement. The endpoint therefore always returns `financiallyComparable: false`, `rankingBasis: none` and `controlApplied: false`. Candidates remain in the requested cap order. No “best” scenario, guarantee, annual saving or automatic economic recommendation is produced. The existing manually supplied quarter-price comparison API remains separate.

## API and validation

All new routes are private (`public: false`): GET/POST `/economics/contracts`, POST `/economics/contracts/restore`, and POST `/economics/replay`. They use local snapshots only; replay makes no network calls or hardware writes. Inputs are bounded to 32 days/3,072 quarters and 20 scenarios; terms are separately bounded.

Synthetic tests cover date/DST boundaries, frozen drafts/tariffs, concurrent publication, idempotent/conflicting restore, independent ESS coverage/versioned export, signed flows, reserve/power/efficiency, recharge/export opportunity cost, conservation, terminal depletion, negative prices, missing data, tariff changes and UI late-response/error handling. A local synthetic browser/API run exercises the settings flow and component display. These do not establish physical billing agreement, AC measurement boundaries, usable battery capacity or native mobile-client acceptance. Those checks remain after review, release and installation; issue #10 remains open for them and for a counterfactual-compatible price source.

## Coupled solar and EV mode

The optional [coupled solar/EV replay](coupled-solar-ev.md) extends this same context and price evaluation with a confirmed hypothetical EV task and two solar priorities. It needs independent PV and charger coverage and a period confirmed to exclude existing EV charging or discharging, retains identical terminal goals, and stays indicative without automatic ranking. The battery-only mode retains its existing behavior.

## Inspecting the selected period

Use the [economic data check](economic-readiness.md) in step 3 to see simultaneous
data gaps before running a scenario. It shares the replay input requirements and
shows bounded missing periods without fetching, backfilling or attesting anything.
A complete data report is not a validated scenario or verified saving; replay
still checks its own fresh inputs, energy boundaries and demand eligibility.

## Shift a measured DC charging session

In **Ekonomisk jämförelse → Flytta ett uppmätt DC-laddpass**, find the most recent completed, continuous DC charging interval in the last seven days. The boundaries are closed quarters with measured idle intervals immediately before and after. Move the start earlier in 15-minute steps, by up to 24 hours. The end stays fixed and the measured profile is stretched in time, preserving its total delivered DC energy. The model checks aggregate grid load and does not model the charger’s minimum sustainable power or guarantee that the charger can reproduce the profile.

The model adds or removes the DC profile on top of measured grid energy using an explicit conversion efficiency and keeps the observed house load, solar, AC charger and home battery behavior fixed. Added load first absorbs measured export; removing load first frees measured import. Changed quarters that originally contained both directions therefore use an approximation. The selection includes complete clock hours around both alternatives. Missing grid data, missing DC evidence at the destination or other DC activity there blocks the scenario. Missing historical hourly prices or dated terms block the indicative energy-cost comparison alone. The highest observed/modelled hour and highest hour within the saved tariff schedule are separate from a monthly demand charge. Fixed fees and wear are excluded.

Enter the shared site limits in **Inställningar → Hushåll**. The app saves them as `householdImportLimits`. The replay checks the whole installation's **quarter-average grid import**, including all observed consumption and the rescheduled profile. You may enter an explicit kW limit, a three-phase main fuse in A, or both. The fuse comparison assumes balanced load, nominal 400 V phase-to-phase and power factor 1. [Schneider Electric Electrical Installation Guide](https://download.se.com/files?p_Doc_Ref=Electrical_installation_guide) With both values, the lower one is used. Exceedances are reported without clipping the shifted profile. Phase currents, transient peaks and whether protection would trip are outside this model.

The authenticated `POST /economics/evdc-session-replay` accepts `{}` for session discovery or `{sessionStart, sessionEnd, minutesEarlier, efficiency}` for replay. Start/end are the UTC milliseconds returned by discovery. The route reads the saved limits and historical data and does not send hardware commands or write settings. Saving the site limits is a separate explicit action.


### Lowest-cost profile outside tariff hours

Choose **Hitta billigaste profilen under importgränsen** to allocate the measured session energy across the allowed quarters. The same request accepts `optimise: true`; then `minutesEarlier` sets the earliest candidate quarter (zero limits the search to the original interval). The model keeps the measured delivery in the final charging quarter and uses at most the peak DC power observed in the session. It holds other loads fixed and rejects any profile with quarter-average grid import at or above the saved household limit.

The search allocates energy in marginal cost order using dated terms and historical effective hourly prices. Available export is used at its opportunity cost, then additional grid import at the buy price. Equal costs prefer later quarters. A quarter with falling marginal cost (sell price higher than buy price when both segments are available) blocks the search. Mixed-direction quarters use the same estimated energy-boundary conversion when subtracting the original DC load and adding new load.

The optimiser only places DC charging in hours outside the dated chargeable tariff periods. It also requires the original pass to have been outside them. Thus tariff-eligible hourly imports are identical and the monthly demand-charge difference is exactly zero under those saved tariff rules, regardless of which monthly peaks were selected. It reports the variable energy cost plus the demand-charge **difference**. A pass that overlaps chargeable hours requires a separate month-level comparison and is blocked. Missing priced/dated quarters or insufficient headroom also block optimisation. The output shows quarter averages for the proposed DC power and total grid import. Charger steps, minimum sustainable power and instantaneous phase loads are outside the model.
