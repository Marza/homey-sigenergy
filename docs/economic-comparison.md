# Economic comparison: inputs and remaining integration

Issue #10 adds contract settings, an authenticated computation endpoint and a strict boundary between demand-charge estimates and complete net costs. It does not establish the household's production contract or enable hardware control.

## Price sources checked on 2026-11-13

[Tibber's GraphQL reference](https://developer.tibber.com/docs/reference) describes `Price.total` as energy plus taxes; the tax component can include Swedish energy tax and VAT. Do not automatically add another energy-tax component to that total. Existing consumption prices are not export payouts.

[Tibber's Data API energy-price documentation](https://data-api.tibber.com/docs/prices/) identifies a potential actual production-contract source: `GET /v1/homes/{homeId}/prices`, with `data-api-prices-read`. It distinguishes consumption and production prices, VAT, and separately billed third-party costs. Production requires a production contract. Its authorization and component semantics must be validated for the applicable account before integration. The existing GraphQL token/cache is not assumed to supply this endpoint or export compensation.

No authenticated production-source request or household-contract validation was performed for this change. No current tax, fee or payout is invented. Issue #10 must stay open for that evidence and source-adapter work.

## Saved assumptions

Settings stores `costContract` separately from optimizer assumptions and credentials. Schema 1 (legacy) requires SEK, a nonempty source reference (up to 300 characters), a real `checkedOn` calendar date, an explicit `importIncludesEnergyTax` boolean, and all six numeric values:

- `energyTaxExVatSekPerKWh`: additional tax absent from the import price.
- `gridImportExVatSekPerKWh`: additional variable grid cost absent from the import price.
- `gridExportBenefitSekPerKWh`: signed export benefit after applicable VAT.
- `gridExportFeeSekPerKWh`: nonnegative export fee after applicable VAT.
- `vatRate`: VAT fraction from 0 to 1, applied only to the additional import components.
- `batteryWearSekPerKWh`: assumed cost per delivered discharge kWh.

New saves use **contract schema 2**, adding `importPriceBasis` and an explicit `otherImportExVatSekPerKWh` amount. The latter is the sum of any missing supplier markups/variable per-kWh charges, excluding monthly fees. It is a separate component from energy tax and the grid transfer fee. No numeric values are prefilled. An absent component must explicitly be entered as zero. If import already includes energy tax, additional tax must be zero. Grid charges already included in a supplied all-in price must likewise have a zero additional fee. `importPriceBasis` must be selected explicitly:

- `total-incl-vat`: the supplied purchase base already includes VAT; do not multiply it again. Add only components absent from that base, with purchase VAT applied to those additions.
- `spot-ex-vat`: the supplied base is raw spot excluding VAT. Add grid, energy tax and other purchase additions before applying `1 + vatRate` once. The included-energy-tax checkbox is incompatible with raw spot and is disabled/cleared by that selection.

The raw-spot formula is `(spot + missingTax + gridTransfer + otherPurchaseAdditions) × (1 + purchaseVAT)`. The inclusive-base formula is `inclusivePurchasePrice + (missingTax + gridTransfer + otherPurchaseAdditions) × (1 + purchaseVAT)`. Export is independently `suppliedPayout + exportBenefit - exportFee`; the app adds **no purchase VAT** to any export amount. A payout supplied without VAT stays without an added VAT multiplier.

The settings form accepts decimal comma or decimal point using decimal keyboard inputs, identifies missing source/date/basis/amounts, shows a formula preview in kr/kWh and confirms saving only after reading back the normalized stored value. Timeout means confirmation is unknown (the value may already be stored), not an instruction to retry blindly. Changes made while a save is pending are labelled unsaved. The explicit source field is above the date field and is required; the header's checkmark is not the cost form's save action.

Old schema-1 settings load with the old inclusive-base meaning and zero **new** other-purchase additions. Reading never writes a migration. The next explicit save uses schema 2; users must inspect its values before changing price basis. Selecting a basis does not reconfigure the existing Tibber price cache or start a price adapter.

Source/date record user provenance, not independent verification. Contract changes during a comparison window require separate calculations; one snapshot cannot represent changing fees. The preview uses its saved cost wear assumption; the existing illustrative optimizer retains its separate wear assumption.

## Authenticated computation

`POST /economics/preview` is private in the Homey manifest. It reads saved `costContract`, performs no settings or hardware writes and returns no credentials. It is a developer-facing computation route; no production-source importer or automatic price fetch is exposed by the cost form.

Legacy body schema 1 contains `currency: "SEK"`, nonempty `importSource` and `exportSource` references, matching `importIncludesEnergyTax`, `prices`, `baseline` and `scenario`. Synthetic examples used in tests are not contract-rate defaults.

Each price row requires:

```json
{
  "t": 1792886400000,
  "end": 1792887300000,
  "importInclVatSekPerKWh": 1,
  "exportSekPerKWh": -0.5
}
```

Body schema 2 additionally requires `importPriceBasis` matching the saved contract, and uses `importPriceSekPerKWh` instead of `importInclVatSekPerKWh` for each interval. This value is interpreted strictly according to that basis. `exportSekPerKWh` remains the supplied final payout amount in both versions. A schema-1 request is refused against a raw-spot contract, so its inclusive-named price field cannot silently become raw spot. Legacy schema-1 bodies/contract settings remain supported in their original inclusive semantics.

Prices are signed SEK/kWh. Export is the actual payout after applicable VAT, before the explicitly separate export benefit and fee; it is never inferred from import. Both prices are required even for an interval with only one direction of energy. All UTC timestamps must describe distinct consecutive 15-minute intervals; prices are not stretched across gaps. Arrays may be unordered and contain at most 3,072 intervals. The arrays describe exactly the supplied window, not a complete billing month by implication.

Both baseline and scenario require `slots`, `dischargeKWh`, `demandChargeSek`, `initialStoredKWh` and `finalStoredKWh`. Each slot has `t`, `gridWh`, nonnegative directional `importWh` and `exportWh`, and `coverageMs: 900000`. Net `gridWh` must equal import minus export. Every price interval must have exactly one complete slot in both series. New observed history now collects directional import/export separately with its own coverage; older net-only quarters and partially upgraded quarters cannot supply complete directional series. The private history endpoint below exposes only eligible closed quarters. Within the observed data, these remain sampled-power estimates rather than meter-counter energy. A supplied `directionalCoverageMs`, when present, must equal full interval coverage for economic evaluation. Within-quarter import and export must not be priced as their net.

Initial stored battery energy must match between baseline and scenario, as must final stored energy. This prevents a cheaper result funded by depleting more battery energy. Recharge must be included in the supplied grid series, and `dischargeKWh` must cover the same window. Demand amounts are explicit nonnegative inputs: the caller must compute both with the same tariff, observed window, billing period and coverage. The endpoint validates their structure, not external billing provenance or physical feasibility. Fixed charges are excluded and must be compared separately if contracts differ.

Import cost is directional import times the selected-base marginal price including only missing tax/grid/other purchase components and purchase VAT as described above. Export revenue uses signed payout plus benefit minus fee. Total is import cost minus export revenue plus demand charge plus discharge wear. Negative import prices and negative export payouts remain signed. Missing or inconsistent inputs return `unavailable` with a reason and no net saving. A successful result is `provisional`, `advisoryOnly`, scoped to supplied intervals and labelled `inputVerification: user-supplied`; comparability describes input structure, not independent verification.

## Directional history collection

New grid pairs retain nonnegative `importWh` and `exportWh` alongside signed `gridWh`. Linear interpolation splits each short segment at quarter boundaries and at a zero crossing; import/export inside the same quarter are not netted away before pricing. `directionalCoverageMs` distinguishes genuinely observed directions from older net-only energy. Source changes, failed reads, off-grid/unknown samples, gaps and restarts do not establish observation continuity. Details and version-4 backup compatibility are in [history format](history-format.md).

Authenticated **GET /economics/energy-history** reads committed history without flushing/writing it or requesting hardware data. It returns an allowlisted series of complete closed quarters, retained-window bounds, eligible/excluded/missing quarter counts and import/export kWh **only for eligible quarters**. Totals are null while no complete quarter exists; valid measured zero remains zero. Open quarters are excluded. Gaps remain gaps, and the window is not a claim of a complete billing month. `basis: sampled-power-or-imported-history` identifies the data as sampled/possibly restored history, not independently verified meter observations. Host/device identifiers, source addresses, credentials and internal state are omitted. Responses still contain private household usage and must stay private.

The **Energiunderlag för ekonomijämförelse** section below cost settings fetches this snapshot only on explicit refresh and labels its approximation and missing data. The endpoint deliberately returns `financiallyComparable: false`: having energy directions does not establish export prices, a feasible counterfactual scenario, recharge, matched battery boundaries, tariffs or bill agreement. It does not unlock runtime cost ranking or manufacture missing history from Tibber/cumulative counters.

## Runtime boundary and remaining work

The existing tariff replay reconstructs a simplified net load, clamps exports and does not establish matching terminal battery energy or a complete recharge ledger. It therefore always reports `rankingBasis: demand-charge-only`, null net savings and an explicit unavailable economic comparison. Legacy `baselineEnergySek` plus `pricesSekPerKWh` cannot bypass this gate. The separate economic endpoint never feeds back into optimizer ranking.

Remaining: verify production-price access and contract semantics, add a source-bound adapter with interval/component provenance, collect sufficient complete directional history and model matching scenario flows/recharge, validate tariff/battery boundaries, and only then connect complete comparisons to runtime ranking. Physical validation and real bill agreement are not established by the synthetic tests. History, tariffs, credentials, installed Homey state and hardware controls are not changed by running the preview.
