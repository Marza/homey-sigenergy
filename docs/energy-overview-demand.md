# Demand charges in Energy overview

The first demand-charge section in the Dashboard widget shows the **current-month provisional amount**. The source label is explicit:

- A matching Tibber meter reference is preferred when enough configured peaks are available.
- If that reference is unavailable, a matching provisional Sigenergy calculation can be shown as a **local estimate**.
- Before either source has enough peaks, eligible peaks and their observed mean are shown immediately, labelled **Medel hittills (n av N)**. A clearly labelled provisional fee is shown as the available mean multiplied by the saved tariff rate. With no eligible hour, both mean and fee remain unknown.

Both sources must match the current Europe/Stockholm month and saved tariff identity. An off-season/invalid/unreadable tariff clears the result. A stale month, changed home binding, read failure or malformed amount cannot retain the previous Tibber value. A usable cached reference keeps its last-fetch time and failed-refresh indication. Missing hours and future eligible hours remain visible; the amount can change as further observations arrive and is not a finalized bill.

The separate **Sigenergy – lokal effektavgift** section retains the locally measured peak estimate. When the saved tariff requires peaks on distinct days, it explains how many of the required days have usable selected peaks. Many hours on only a few days do not satisfy this condition. Both sections provide collapsible selected-peak lists: at most 31 completed, unique hourly timestamps and nonnegative kW values, restricted to the result's Stockholm month. Entries use Swedish local time with UTC offset. Extra metadata, IDs and credentials are omitted; the widget does not receive the full household time series.

Presentation does not combine meter hours with inverter quarters, supply missing battery/solar history, alter the tariff calculation, or use Tibber data to fabricate battery savings.

Automated fixtures cover meter preference with insufficient local history, clearly sourced local fallback, source-binding/month/tariff changes, missing/failed reads, invalid amounts, absence of simulated savings and phone/desktop layout in light/dark mode. Physical Homey Dashboard acceptance is still required after installing a merged release.

## Progress from the first eligible hour

A five-day tariff does not require waiting five days to see any data. After the first completed eligible clock hour has been collected and the saved estimate refreshes, its selected peak and observed mean can be displayed. With distinct days, additional hours on that day can revise its maximum without increasing the number of selected days. Closed, covered hours inside the configured season, calendar and time window are still required. Tibber reporting delays remain separate from local collection.

The observed mean divides by the number of available selected peaks, explicitly shown as `n av N`. It is not the final configured `N`-peak mean: missing future peaks are neither invented nor treated as zero. `averageKw`, `estimatedSek`, calculator status and simulation eligibility are unchanged. The widget-only provisional fee uses `observedAverageKw × rateSekPerKw`, rounded for display in the same way as completed estimates. It is labelled as based on `n av N` days/peaks and an incomplete underlay; new peaks and corrected data can change it. Zero is valid when the observed mean or saved rate is zero. Nonfinite products stay unavailable. Only the display projection gains `observedAverageKw` and sanitized `selectedPeakHours`. Legitimate zero peaks are visible. Changed months/tariffs/source bindings, absent or failed reads, future/open/unaligned/duplicate peak hours and invalid values cannot restore stale lists or partial means.

Local fixtures cover one-day maximum selection with multiple hours, zero peaks, transition from partial to full, the local-time month boundary and first-day Tibber/local rendering. The partial fee preview does not mark the tariff calculation complete or enable a savings estimate, recommendation or hardware action.
