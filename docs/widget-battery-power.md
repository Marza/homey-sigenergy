# Battery power in Energy overview

The battery tile shows SoC and the latest saved quarter's average net battery power. The existing plant convention is positive `essW` = charging (`Laddar`), negative = discharging (`Urladdar`); the displayed magnitude uses kW. An observed zero shows `Vila 0 kW`. Power uses its own observation count so optional EV readings cannot dilute its average.

This is a saved quarter average, not an instantaneous value or separate gross charge/discharge measurements. Charging and discharging within the same quarter can cancel in the net average. The widget labels it `Nettoeffekt · kvartsmedel`. It refreshes with the existing 30-second overview poll.

Missing/invalid observations show a dash, independently of SoC availability. Source errors, disablement, stale history and failed widget API requests clear the battery power along with the other plant readings. The widget's existing content-height handling accommodates the added text. This change only projects existing history fields and renders them; no new hardware reads or writes are introduced.
