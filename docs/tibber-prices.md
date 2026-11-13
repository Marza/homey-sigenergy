# Tibber price contract and coverage

## Verified interface

On 2026-11-13, read-only requests to Tibber's GraphQL endpoint verified both `priceInfo(resolution: QUARTER_HOURLY)` and `priceInfo(resolution: HOURLY)` with `today`/`tomorrow` entries containing `startsAt`, `total` and `currency`. The selected subscription returned 96 quarters or 24 hours per day and currency SEK. This is one observed account, not a compatibility guarantee for every market/subscription. The [official schema reference](https://developer.tibber.com/api/reference.md) documents the explicit resolution argument; omitting it retains backward-compatible hourly prices.

`test/fixtures/tibber-quarter-hourly.json` and `test/fixtures/tibber-hourly.json` preserve that response structure, offsets and timestamps. Home IDs are replaced and every price is synthetic. Neither file includes a token, account identity, address or measured consumption. Additional fixtures for DST days, missing intervals and malformed responses are constructed in tests.

## Normalization

The runtime explicitly requests quarter-hour consumption prices. The normalizer also supports explicitly requested hourly responses. Ends are calculated using the requested 15- or 60-minute resolution, including the final interval; neighboring starts never extend a price across a gap. Entries must be aligned and belong to their stated Stockholm calendar day. Null/non-finite prices, missing offsets, unsupported currency/resolution and invalid/mixed alignment fail validation. Negative numeric prices are valid. Identical duplicate entries are deduplicated and counted; conflicting duplicates reject the response. This app accepts SEK only and performs no currency conversion.

The bounded cache retains the full returned today/tomorrow lists to evaluate coverage, not a promised 48-hour horizon. Missing quarters remain gaps. Tomorrow is complete only when its entire Europe/Stockholm day is covered, including 23- and 25-hour DST days. The chart positions bars by time, leaves gaps visible and distinguishes negative prices.

Schema-2 price caches record the requested resolution and currency. Older caches inferred their ends and are retained but cannot supply prices to plans until a fresh validated fetch replaces them. This price-cache version is independent of the history/export schema.

## Fetching, errors and configuration

The app fetches on startup and checks refresh eligibility every five minutes. It normally refreshes hourly; after 13:00 Stockholm time it retries at 15-minute intervals until tomorrow is complete. Missing current prices also select the 15-minute retry interval. Saving credentials makes the next five-minute check eligible. The UI reports earliest eligibility, not a precise scheduled execution time. Invalid/future last-attempt timestamps cannot block retries indefinitely.

Failed network/API/validation requests keep the previous cache. Known verified intervals remain usable until their ends, even when the last refresh failed; the fetch error and interval coverage are reported separately. Expiry depends on interval ends rather than treating every price as stale after an arbitrary fetch age. Invalid/future cache timestamps are rejected. Diagnostics display fetch age, last attempt, available range, missing periods and tomorrow's covered/expected hours.

Changing credentials or selected home invalidates pending requests and the old configuration's cached prices. A private credential fingerprint binds a random cache revision to the configuration across app restarts; neither the fingerprint nor credentials are returned by diagnostics or history export. Unchanged configuration can keep using a verified cache during an offline restart. Error messages omit upstream response/cause text that could echo credentials.

## Charging plans and limits

Plans allocate energy only in explicit, finite-priced intervals. Null/string/non-finite prices are not zero. Each deadline includes coverage and exact gaps; unmet energy remains explicit. A feasible plan with incomplete pricing is marked `partial-prices`, since missing prices prevent a complete economic comparison. An already met target can need no charging regardless of price gaps. Cached prices do not prove that a vehicle is connected or enforce a charging schedule.

The price input is Tibber's reported consumption `total`, not verified all-in billing cost or export remuneration. Taxes/grid fees, production payouts, wear and tariff ranking remain separate work in issue #10. All results remain advisory, and no device writes were introduced. HTTP behavior is tested with controlled responses; live failures, Dashboard behavior and every subscription/currency have not been physically validated.
