# Economic comparison: inputs and remaining integration

Issue #10 adds contract settings, an authenticated computation endpoint and a strict boundary between demand-charge estimates and complete net costs. It does not establish the household's production contract or enable hardware control.

## Price sources checked on 2026-11-13

[Tibber's GraphQL reference](https://developer.tibber.com/docs/reference) describes `Price.total` as energy plus taxes; the tax component can include Swedish energy tax and VAT. Do not automatically add another energy-tax component to that total. Existing consumption prices are not export payouts.

[Tibber's Data API energy-price documentation](https://data-api.tibber.com/docs/prices/) identifies a potential actual production-contract source: `GET /v1/homes/{homeId}/prices`, with `data-api-prices-read`. It distinguishes consumption and production prices, VAT, and separately billed third-party costs. Production requires a production contract. Its authorization and component semantics must be validated for the applicable account before integration. The existing GraphQL token/cache is not assumed to supply this endpoint or export compensation.

No authenticated production-source request or household-contract validation was performed for this change. No current tax, fee or payout is invented. Issue #10 must stay open for that evidence and source-adapter work.

## Saved assumptions

Settings stores `costContract` separately from optimizer assumptions and credentials. Schema 1 requires SEK, a nonempty source reference (up to 300 characters), a real `checkedOn` calendar date, an explicit `importIncludesEnergyTax` boolean, and all six numeric values:

- `energyTaxExVatSekPerKWh`: additional tax absent from the import price.
- `gridImportExVatSekPerKWh`: additional variable grid cost absent from the import price.
- `gridExportBenefitSekPerKWh`: signed export benefit after applicable VAT.
- `gridExportFeeSekPerKWh`: nonnegative export fee after applicable VAT.
- `vatRate`: VAT fraction from 0 to 1, applied only to the additional import components.
- `batteryWearSekPerKWh`: assumed cost per delivered discharge kWh.

No numeric values are prefilled. An absent component must explicitly be entered as zero. If import already includes energy tax, additional tax must be zero. Grid charges already included in a supplied all-in price must likewise have a zero additional fee. Source/date record user provenance, not independent verification. Contract changes during a comparison window require separate calculations; one snapshot cannot represent changing fees. The preview uses its saved cost wear assumption; the existing illustrative optimizer retains its separate wear assumption.

## Authenticated computation

`POST /economics/preview` is private in the Homey manifest. It reads saved `costContract`, performs no settings or hardware writes and returns no credentials. It is a developer-facing computation route; no production-source importer or automatic price fetch is exposed by the cost form.

Body schema 1 contains `currency: "SEK"`, nonempty `importSource` and `exportSource` references, matching `importIncludesEnergyTax`, `prices`, `baseline` and `scenario`. Synthetic examples used in tests are not contract-rate defaults.

Each price row requires:

```json
{
  "t": 1792886400000,
  "end": 1792887300000,
  "importInclVatSekPerKWh": 1,
  "exportSekPerKWh": -0.5
}
```

Prices are signed SEK/kWh. Export is the actual payout after applicable VAT, before the explicitly separate export benefit and fee; it is never inferred from import. Both prices are required even for an interval with only one direction of energy. All UTC timestamps must describe distinct consecutive 15-minute intervals; prices are not stretched across gaps. Arrays may be unordered and contain at most 3,072 intervals. The arrays describe exactly the supplied window, not a complete billing month by implication.

Both baseline and scenario require `slots`, `dischargeKWh`, `demandChargeSek`, `initialStoredKWh` and `finalStoredKWh`. Each slot has `t`, `gridWh`, nonnegative directional `importWh` and `exportWh`, and `coverageMs: 900000`. Net `gridWh` must equal import minus export. Every price interval must have exactly one complete slot in both series. Current history only has net energy, so it cannot supply these directional series without new observation/model work. Within-quarter import and export must not be priced as their net.

Initial stored battery energy must match between baseline and scenario, as must final stored energy. This prevents a cheaper result funded by depleting more battery energy. Recharge must be included in the supplied grid series, and `dischargeKWh` must cover the same window. Demand amounts are explicit nonnegative inputs: the caller must compute both with the same tariff, observed window, billing period and coverage. The endpoint validates their structure, not external billing provenance or physical feasibility. Fixed charges are excluded and must be compared separately if contracts differ.

Import cost is directional import times the VAT-inclusive import price plus only additional tax/grid components. Export revenue uses signed payout plus benefit minus fee. Total is import cost minus export revenue plus demand charge plus discharge wear. Negative import prices and negative export payouts remain signed. Missing or inconsistent inputs return `unavailable` with a reason and no net saving. A successful result is `provisional`, `advisoryOnly`, scoped to supplied intervals and labelled `inputVerification: user-supplied`; comparability describes input structure, not independent verification.

## Runtime boundary and remaining work

The existing tariff replay reconstructs a simplified net load, clamps exports and does not establish matching terminal battery energy or a complete recharge ledger. It therefore always reports `rankingBasis: demand-charge-only`, null net savings and an explicit unavailable economic comparison. Legacy `baselineEnergySek` plus `pricesSekPerKWh` cannot bypass this gate. The separate economic endpoint never feeds back into optimizer ranking.

Remaining: verify production-price access and contract semantics, add a source-bound adapter with interval/component provenance, collect or model directional energy and complete recharge, validate tariff/battery boundaries, and only then connect complete comparisons to runtime ranking. Physical validation and real bill agreement are not established by the synthetic tests. History, tariffs, credentials, installed Homey state and hardware controls are not changed by running the preview.
