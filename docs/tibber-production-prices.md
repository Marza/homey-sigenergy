# Tibber production prices and observed variable costs

This feature joins Tibber Data API consumption/production prices to the app's complete, closed directional energy quarters. It provides observed import cost and export revenue for the covered period. It does not infer battery savings, compare simulated scenarios, change optimizer ranking, fill historical measurement gaps or control any equipment. Issue #10 remains open for the remaining economic comparison work.

## Set up a separate price connection

The GraphQL personal access token used elsewhere in the app cannot authenticate to the Data API. Existing GraphQL prices and consumption history remain independent.

1. Register your own **public OAuth client with PKCE** using [Tibber's client instructions](https://data-api.tibber.com/docs/managing-clients/). Register exactly `https://callback.athom.com/oauth2/callback` as its redirect URI, without a trailing slash. This repository does not supply a shared client registration or a client secret.
2. Enable `openid profile email offline_access data-api-user-read data-api-homes-read data-api-prices-read` for that client. Tibber account/client availability and consent are prerequisites; the app cannot grant itself access.
3. In the app settings, find **Tibber köp- och säljpriser – observerad kostnad**, enter the public Client ID, prepare the login and open the login link. Sign in to Tibber and consent. Return to the settings; connection status is polled during login. A new login expires after ten minutes.
4. Select the Tibber home and explicitly confirm that it represents the same meter/plant as the Sigenergy installation. The app cannot verify this relationship automatically. Selection clears this connection's previous prices and manual network confirmation.
5. Request prices. The app subsequently checks eligibility every five minutes, retries hourly when tomorrow's prices are incomplete or an error occurs, and refreshes daily once tomorrow is complete. Provider rate limits can lengthen the wait. The refresh button respects this backoff.

Refresh tokens are renewed automatically, serialized to handle rotation, and saved before using the new access token. Tokens and PKCE verifiers are never returned through these settings routes, logged, included in history exports or committed to the repository. Credentials are stored locally in Homey app settings; this is not a claim of encrypted secret storage. Disconnect removes this connection's local credentials, cached prices and component confirmation. It does not revoke Tibber-side consent or alter the separate GraphQL connection. Revoke consent with Tibber if desired.

## Price meaning and VAT

The source is [`GET /v1/homes/{homeId}/prices`](https://data-api.tibber.com/docs/prices/). Both signed prices and strict decimal strings are supported. This app accepts SEK and explicit quarter-hour timestamps only. Consumption `price` already includes Tibber's supplier markup/fees and applicable VAT. Production `price` is used as returned, without multiplying it by the purchase VAT rate. Production can be absent when the account has no applicable production contract; missing payouts are not replaced by the consumption price or a guessed spot price.

By default, the ledger includes **Tibber trade only**. Optional `thirdPartyPrice` and `subsidizedPrice` are not added automatically. Their billing meaning can differ by country and contract. The app does not reconstruct a spot price by reversing consumption fees.

The optional network mode uses the saved cost contract only after explicit confirmation that its tax/network/export components are billed separately from Tibber's trade price. It requires a schema-2 `spot-ex-vat` contract, no included-tax flag, and matching purchase VAT. It adds:

- import: `(energyTaxExVatSekPerKWh + gridImportExVatSekPerKWh) × (1 + vatRate)`;
- export: `gridExportBenefitSekPerKWh - gridExportFeeSekPerKWh`, in final applicable amounts.

`otherImportExVatSekPerKWh` is deliberately ignored here: Tibber's supplier additions are already in its consumption price. Fixed monthly fees, demand charges and battery wear are excluded. Changing the saved contract, connection or selected home invalidates network confirmation. A mismatch prevents affected totals rather than silently substituting assumptions. Confirming components is the user's responsibility; this feature cannot validate a bill or a tariff contract.

## Coverage, caching and failure behavior

Only schema-2 energy quarters with full net and directional coverage, finite nonnegative import/export and consistent net energy are eligible. Open, legacy, partial and missing quarters are excluded. Each eligible quarter also needs both consumption and production prices, even if one direction has zero energy. The UI reports matched quarters, missing purchase/production prices, VAT mismatches, excluded quarters and energy gaps. Partial totals describe only the matched subset and must not be treated as a whole-period bill.

Price requests start at the earliest eligible retained energy quarter, or the current quarter if there is no eligible history. Pagination is limited to 20 pages, 192 items per page and the selected home's HTTPS price endpoint. Foreign hosts/homes, loops, conflicting duplicate rows within a fetch, unsupported currencies, malformed timestamps and non-finite values fail validation. Later successful fetches can replace cached provider prices, including corrections and newly available production prices. A maximum 2 MiB/3,400-row cache retains up to 32 days of prices and a small future window. No missing energy history is created.

Errors preserve the last valid, source-bound cache. Disconnects, home changes and shutdown invalidate pending results; a late response cannot repopulate the old connection. Error statuses omit upstream response bodies and credentials. Cached historic intervals remain usable offline, with their fetch time shown through the private API. A fetch error does not make a partial ledger complete.

The routes in `api.js` are authenticated (`public: false`): `/tibber/data/status`, `/connect`, `/homes`, `/home`, `/components`, `/refresh`, `/disconnect` under `/tibber/data`, and `/economics/observed`. Home names and IDs are visible only in the owner's private settings flow. Do not paste credentials, home identifiers or household measurements into public issues.

## Verification and limitations

`test/tibber-data.test.js` uses synthetic homes, tokens, tariffs, energy and prices. It covers PKCE, token rotation/concurrency, authorization failure and expiry, cross-source invalidation, pagination bounds, partial prices, negative payouts, VAT and avoiding duplicate supplier additions. Browser checks cover the settings connection and observed-cost display with synthetic responses. Packaging verification checks that the new routes and runtime/UI files survive the Homey build.

Live authorization, client registration, each account's production-price availability and comparison with an actual bill still require owner verification after installation. No physical-installation result is claimed by these tests. See [Tibber authentication](https://data-api.tibber.com/docs/auth/), [scopes](https://data-api.tibber.com/docs/scopes/) and [Homey's OAuth callback API](https://apps-sdk-v3.developer.homey.app/ManagerCloud.html) for the platform contracts.
