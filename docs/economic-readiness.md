# Economic comparison data check

The **Kontrollera periodens underlag** button in economic comparison step 3
inspects local data before running a scenario. Select the hours and battery-only
or solar/EV mode first. It does not fetch Tibber history, run a simulation, save
settings, publish contracts or confirm historical assumptions.

The private, authenticated `POST /economics/readiness` accepts only
`{ "hours": 24, "mode": "battery" }` (1–768 hours) or `"solar-ev"` (1–168 hours).
The window ends at the most recent completed UTC clock hour. Every required
quarter is checked over that same window; a missing price cache or contract does
not hide independent energy gaps.

## What is checked

- Tibber home selection/confirmation and a cache matching the current private
  connection revision. No token, home identifier or revision is returned.
- Complete schema-2 directional energy, consistent import/export/net values and
  independent battery coverage. Valid zeros remain valid; legacy coverage is not
  inferred or backfilled.
- Both purchase and production prices for every hour, including negative/zero
  prices. Invalid, future-dated or mismatched caches are not trusted. Valid
  historical prices do not expire merely because they are old.
- Valid frozen cost versions covering each quarter under Stockholm local dates.
  Undated drafts and checked dates are not effective dates.
- In solar/EV mode: separate PV and EVDC coverage, nonnegative solar energy,
  and solar/residual-load consistency. A fully measured zero EVDC quarter is
  eligible. Missing EVDC coverage and observed vehicle charging or discharging
  are reported separately. The mode also requires exactly one plant, valid
  saved charging configuration, and the existing owner confirmations.

`comparison-data.js` supplies the shared energy, battery, price and contract scan
used by battery replay. Solar replay and inspection share the same additional
solar/EV predicates. The cost arithmetic and scenario execution remain separate.

## Report and limits

The report contains source prerequisites plus per-category states:
`complete`, `missing`, or `unavailable`. Unreadable/invalid source data produces
unknown counts (`null`), never a fabricated zero-gap result. Counts distinguish
missing/blocked quarters, equivalent duration, and distinct affected clock hours.
Adjacent gaps are coalesced into half-open `[from, to)` UTC-millisecond ranges.
Each category returns at most 24 ranges with an exact total range count and a
truncation flag; counts still cover the entire window. UI dates use Stockholm
with UTC offsets so repeated autumn clock hours remain distinguishable.

`dataComplete: true` means the data requirements in this basic check passed.
It does **not** validate battery/EV model inputs, terminal-energy restoration,
charging goals, demand-peak eligibility, changes of demand tariff inside a month,
measurement calibration, or counterfactual settlement. `modelValidated` and
`demandEvaluated` remain false, as do `financiallyComparable` and `controlApplied`;
`rankingBasis` remains `none`. Existing effective hourly price caveats still apply.
There is no automatic financial ranking or hardware command.

The UI labels the result as a snapshot, clears it on period/mode changes and
relevant source/contract/history actions, and expires it at the next hour boundary.
Late responses, malformed responses and transport errors cannot restore a cleared
result. Background data may change after inspection; replay always reads and
validates a fresh snapshot, regardless of whether inspection was run.

The response excludes raw energy, prices, contract text/rates, credentials,
identifiers, fingerprints and internal context. Gap timestamps are still private
usage metadata and should not be published without permission. Tests use synthetic
fixtures; a complete report does not establish billing or physical accuracy. This
is a follow-up within #10, which remains open for the broader validation work.
