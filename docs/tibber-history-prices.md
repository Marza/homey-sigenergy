# Historical trade prices through the existing Tibber connection

This feature reuses the app's GraphQL personal access token (`tibberToken`), configured home (`tibberHomeId`) and source revision. It requires no Data API access, OAuth login, client registration, additional credential or cloud callback. The existing today/tomorrow quarter-hour consumption-price fetch and meter-consumption sync remain independent.

## Setup and source

Save the existing Tibber settings as usual. If the home field is blank, a successful ordinary price fetch can supply its single selected home through its revision-bound cache. Multiple homes require an explicit Home ID in the existing settings. In **Tibber – historiska köp- och säljpriser**, confirm that this home represents the same meter/plant as Sigenergy, then fetch history. Token/home changes require confirmation again and prevent old cached results from being used.

The source is [Tibber's official GraphQL schema](https://developer.tibber.com/api/reference.md): `Home.consumption` and `Home.production`, requested with `resolution: HOURLY`. Both expose `from`, `to`, `unitPrice`, `unitPriceVAT` and currency, with consumption/cost or production/profit. Production availability depends on the account and settlement data may arrive late. The finest documented production-history resolution is hourly; this integration does not claim quarter-hour export prices or future production prices.

The app uses finite SEK `unitPrice` as returned. It does not derive price by dividing profit by energy, copy the purchase price into a missing payout, reconstruct spot prices or add `unitPriceVAT` again. Where quantities and amounts are supplied, their product must agree with the unit price within a small rounding tolerance; inconsistent records are rejected. `unitPriceVAT` is a reported amount per unit, not a VAT percentage. The schema describes consumption cost as including applicable VAT and excluding some fees/rewards where applicable; these fields are not proof of a complete bill. Missing or contract-specific components remain outside the default reported-price calculation.

## Honest hourly comparison

The app groups four consecutive complete, closed directional energy quarters into a UTC-aligned hour matching the source interval. Each quarter must already meet the directional history eligibility rules. Missing, open, legacy or partial quarters prevent the hour from qualifying. A matched hour also needs both consumption and production prices, including when one energy direction is zero. Missing prices remain missing.

The effective hourly unit price can reflect the actual meter's within-hour consumption/export pattern. Applying it to energy integrated from Sigenergy samples is **indicative**, not exact quarter-hour settlement. Opposing within-hour patterns and sampling differences can affect the result. The UI and API identify `HOURLY`, `historical-effective-unit-price` and `indicative-hourly`; `financiallyComparable` always remains false. These effective prices cannot support ranking hypothetical battery scenarios without a verified comparable price/energy model.

Totals describe only matched hours: observed import kWh × reported purchase unit price and observed export kWh × reported production unit price. Signed/negative prices are preserved. The UI exposes matched hours, missing price hours, incomplete energy quarters, gaps and complete quarters left outside whole hours. Empty coverage produces no cost totals. This does not backfill energy history or calculate battery savings.

## Optional separate network components

Default totals contain only the reported trade unit prices. They do not assert that all Tibber fees are included. The optional network mode requires an explicit confirmation of separately billed network/tax/export components and a validated schema-2 `spot-ex-vat` cost contract with no included-tax flag. It adds:

- import: `(energyTaxExVatSekPerKWh + gridImportExVatSekPerKWh) × (1 + vatRate)`;
- export: `gridExportBenefitSekPerKWh - gridExportFeeSekPerKWh`, in final applicable amounts.

Supplier additions (`otherImportExVatSekPerKWh`) are not added automatically because their inclusion in the source must be established before combining them. The saved VAT rate applies only to the explicitly separate purchase additions; no extra purchase VAT is applied to production payouts or export benefit. Changing the cost contract invalidates network confirmation. Fixed fees, demand charges, battery wear, rewards and counterfactual savings remain excluded. Confirm the component meaning against the contract and bill before interpreting totals.

## Scheduling and failure behavior

A five-minute timer checks eligibility after confirmation. Requests cover the retained observed history, at most 32 days, and only closed hours. They are split into at most two time windows of no more than 744 hours, using GraphQL variables and the fixed HTTPS endpoint. Currency, timestamps, interval length, quantities, bounds and conflicting duplicates are validated. No provider pagination URLs are followed.

Complete returned price history is refreshed daily. Missing prices/production or failures retry after an hour; `Retry-After` on rate limiting can extend this, bounded to a day. The manual refresh respects backoff. A failed fetch retains the previous valid cache; valid successful snapshots replace it. The bounded cache holds at most 768 normalized hours/2 MiB. Status exposes its fetch time and next attempt, never the token, source fingerprint or home ID.

Credential/home changes invalidate cached visibility and pending requests, including changes before the app's source listener runs. Shutdown blocks later writes. Errors omit provider response bodies and credentials. Existing GraphQL credentials and caches are not altered. The private API comprises `/tibber/history-prices/status`, `/confirm`, `/components`, `/refresh` under `/tibber/history-prices`, plus `/economics/observed`; all manifest routes use `public: false`.

## Verification

Synthetic tests cover existing-token request headers, home selection and source binding, bounded windows, negative prices, VAT amounts, missing production, duplicate/malformed data, hourly grouping, retry/cache behavior, pending-request invalidation and private routes. Browser checks exercise confirmation, optional components, partial coverage and failure states without account data. Homey build checks verify runtime/UI files and authenticated routes are packaged.

Live production-field availability, account-specific component semantics and comparison with actual billing remain owner verification steps after installation. No physical or household observations are published here. Issue #10 stays open for verified scenario pricing, matching battery boundaries and runtime financial comparison.
