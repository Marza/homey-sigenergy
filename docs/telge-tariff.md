# Telge demand-tariff reference

Checked against Telge Elnät's public pages on **13 November 2026**. This is a dated reference, not an automatically updated tariff feed or confirmation of an individual contract. No preset or rate is installed automatically.

## Published rules

Primary sources:

- [Telge Elnät: prices](https://www.telge.se/elnat/priser-abonnemang/elnatspriser/), section **Säkring 16 A–63 A**, prices stated as effective 1 January 2026, including VAT. The page also has a separate apartment tariff effective 1 November 2026; do not apply that category to a fuse subscription.
- [Telge Elnät: demand charge](https://www.telge.se/elnat/priser-abonnemang/effektavgiften/), including both calculation FAQs.
- [Swedish public holidays, SFS 1989:253](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-1989253-om-allmanna-helgdagar_sfs-1989-253/).

For a **25 A fuse subscription**, within the published 16–63 A category:

| Parameter | Published rule / configuration |
| --- | --- |
| Season | November–March: `months: [11,12,1,2,3]` |
| Window | Weekdays 07:00–20:00 Stockholm time; `start: "07:00"`, `end: "20:00"`, `weekdays: [1,2,3,4,5]` |
| Exclusions | Public holidays, Christmas Eve and New Year's Eve; select `calendar: "se-telge"` |
| Demand interval | Mean power for each clock hour, not its instantaneous maximum |
| Peak selection | Mean of the month's five highest eligible hourly values, at most one per day; `peakCount: 5`, `distinctDays: true` |
| Rate reference | **125.10 SEK/kW per high-load month, including VAT**, published for 2026; verify the applicable invoice/contract before entering `rateSekPerKw: 125.1` |
| Other bill components | Fixed fee, energy transfer and taxes are outside this demand estimate |

The app multiplies the selected mean by the entered rate. It does **not** add or remove VAT. An excluding-VAT rate gives an excluding-VAT estimate. The rate is user-maintained; this document does not establish prices for 2027 or a different customer category. Apartment customers are outside this reference.

The holiday calendar includes the statutory Swedish holidays and the two explicitly named Telge eves. It does not assume that all holiday eves are holidays. Generic configurations remain available without holiday exclusions.

## Measurement and coverage limitations

The public description establishes the clock-hour average but does not settle the exact import/export settlement treatment for a site with generation and storage. Current history records a **signed net grid-energy integral** from inverter polling. The estimator sums the four quarters, then clamps a negative hourly sum to zero. Export within a quarter or hour can offset import in that representation. It cannot reconstruct separate gross-import and gross-export meter channels. This approximation is not validated against Telge's settlement meter or a bill.

Each accepted quarter must be aligned and have at least 14 minutes of coverage. Four quarters are required per hour; this tolerance does not certify a perfectly observed hour. Missing quarters, duplicates, absent hours and open/future hours cannot silently become complete observed hours. All estimates stay provisional even when the coverage counter says `complete`: that flag describes this app's accepted input coverage, not tariff or meter verification.

The current month will normally have remaining hours. Installation partway through a month also leaves missing elapsed hours. The widget exposes both. Historical replay concerns the observed input hours only, shares their coverage, and cannot establish a complete-month saving from a partial sample. No hardware writes are enabled.

## Reproducible synthetic reference

`test/tariff-calendar.test.js` deliberately uses generated observations, **not a customer's meter export**:

- January 1, 2026 at 10:00 Stockholm: 99 kW; excluded as a holiday.
- January 7 at 10:00: 4 kW; at 11:00: 8 kW; only that day's 8 kW qualifies for distinct-day selection.
- January 8 at 10:00: 6 kW.
- With an explicitly synthetic two-peak configuration: mean `(8 + 6) / 2 = 7 kW`; fee `7 × 125.10 = 875.70 SEK`.

This also expects 260 eligible hours in January 2026 (20 eligible weekdays × 13 hours). Separate tests cover spring/autumn DST, month boundaries, Easter holidays, incomplete and duplicate hours, configuration round trips and baseline/replay coverage. These validate the implementation's rules, not billing accuracy.

## Remaining acceptance work for issue #7

Keep [issue #7](https://github.com/Marza/homey-sigenergy/issues/7) open until a sanitized reference month from the settlement meter and invoice has been compared. Record the applicable tariff period and VAT basis, eligible hourly values, selected five daily maxima, their mean and demand fee; document differences from the inverter integrals and the import/export settlement rule. Do not publish tokens, customer numbers or identifiable household time series in the public repository. Use synthetic fixtures for public regression tests unless publication of a sanitized dataset is explicitly authorized.
