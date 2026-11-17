# Demand charges in Energy overview

The first demand-charge section in the Dashboard widget shows the **current-month provisional amount**, before recommendations and local simulations. The source label is explicit:

- A matching Tibber meter reference is preferred when enough configured peaks are available.
- If that reference is unavailable, a matching provisional Sigenergy calculation can be shown as a **local estimate**.
- If neither source is eligible, the amount stays unknown with an explanatory message.

Both sources must match the current Europe/Stockholm month and saved tariff identity. An off-season/invalid/unreadable tariff clears the result. A stale month, changed home binding, read failure or malformed amount cannot retain the previous Tibber value. A usable cached reference keeps its last-fetch time and failed-refresh indication. Missing hours and future eligible hours remain visible; the amount can change as further observations arrive and is not a finalized bill.

The separate **Sigenergy – lokal beräkning och simulering** section retains the locally derived baseline and simulation. When the saved tariff requires peaks on distinct days, it explains how many of the required days have usable selected peaks. Many hours on only a few days do not satisfy this condition. The snapshot exposes only a bounded peak count, not the selected household timestamps or individual peak readings.

Presentation does not combine meter hours with inverter quarters, supply missing battery/solar history, alter the tariff calculation, or use Tibber data to fabricate battery savings. Simulation and recommendation eligibility remain unchanged. A complete monthly reference therefore does not imply that a local battery simulation is ready.

Automated fixtures cover meter preference with insufficient local history, clearly sourced local fallback, source-binding/month/tariff changes, missing/failed reads, invalid amounts, absence of simulated savings and phone/desktop layout in light/dark mode. Physical Homey Dashboard acceptance is still required after installing a merged release.
