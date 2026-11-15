# Measurement gaps and incident diagnostics

Open **Inställningar → Data och backup → Mätluckor och händelser**, choose a period and press **Uppdatera diagnostik**. Results are a local read-only snapshot. Changing the period or a failed/timed-out request hides old results. All displayed times use Europe/Stockholm, with seconds and local DST handling.

The view separates:

- Missing or incomplete grid, battery and solar quarters. Grid and battery use the same coverage predicates as economic replay; solar requires a full independent power integral. Quarter windows end at the latest closed quarter.
- Missing historical Tibber purchase and sale prices, checked independently for closed whole hours. The price section displays its own hour-aligned window, cache timestamp and earliest next attempt. A successful last response does not mean newer hours already have prices.
- Registered observations: app lifecycle, reader/source changes, invalid samples, gaps exceeding the 60-second integration limit, off-grid exclusions, classified Modbus failures, polling loops longer than 60 seconds, failed/recovered history writes, imports, and price-fetch outcomes.
- History readability, serialized size, budget, revision, checkpoint time, buffered quarters and diagnostic-journal health. These are application-level observations, not a disk durability check or a cross-process transaction guarantee.

A quarter can be present but ineligible because a short part of it lacks coverage. It is not necessarily a deleted record. Values across restarts, source changes, failed reads or long observation gaps are not invented. Main plant read failures invalidate grid, battery and solar continuity; independent EVDC samples cannot repair them.

## Evidence and limits

The separate app-setting key `dataGapDiagnostics` keeps at most 500 allowlisted observations within 32 days. Overlapping observations with the same source and reason are coalesced. Only categories and timestamps are stored: no raw upstream error text, tokens, home IDs, network addresses, readings or prices. The view uses an authenticated app API; it does not query Tibber or change stored measurements when opened.

New observations begin with this version. Earlier missing coverage is shown with **Ingen orsak registrerad för perioden**. Events overlapping a displayed range are labelled as registered context; they do not establish the cause of every missing instant. A coalesced interval ends at its latest observation, not necessarily at a confirmed hardware recovery. No reason is inferred solely from a nearby restart.

Journal failures do not stop collection or price fetching. Pending observations are retained in memory and retried at the next periodic history checkpoint; history-write failures similarly retain the measurement buffer. Abrupt termination can lose uncommitted memory, including diagnostic observations; this logger cannot reconstruct an unobserved outage or guarantee recording its own storage failure. Corrupt stored journals are reported unavailable and are not overwritten automatically. The journal is separate from history/contract backups and is not included in their existing export formats.

The normal history snapshot and its retention are unchanged: up to 32 days of quarters and 730 daily summaries. The journal does not backfill coverage or enable hardware writes. Tibber pricing uses the existing saved connection and rate-limit protection; see [historical prices](tibber-history-prices.md).
