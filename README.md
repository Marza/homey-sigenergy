# v0.12 – diagnostik och temperaturunderlag

- Ny diagnostikflik i Homeys appinställningar för SigEnergy, batteritelemetri, Nibe, Tibber och EVDC. Visar fel, saknade och inaktuella data.
- Temperaturunderlag: Nibe BT1 och aktuella BMS-effektgränser; ingen påhittad temperaturkurva eller automatisk styrning.
- Batteritemperatur kräver verifierat register och visas därför inte som uppmätt innan det finns.
- Inlärningsläge förblir strikt läsbaserat; inga Modbus-skrivningar.
- Kräver verifiering på riktig Homey och registerprofil innan operativ användning.

# Sigenergy Local Monitor — v0.1.0 (read-only)

For Homey Pro 2023 and SigenStor EC 17.0 TP. This is an initial SDK v3 app scaffold, not a production-certified controller. **No Modbus writes.**

## Install

1. Install Node.js and Homey CLI on your development Mac (`npm install -g homey`).
2. `npm install` in this folder.
3. Log in with `homey login`, then `homey app run` to test on Homey Pro.
4. Pair the Sigenergy plant device, then change advanced settings to the actual inverter LAN IP and Modbus port 502. Default unit ID is 247.
5. Confirm grid power sign, PV power, SoC and capacity against mySigen.

## Important

- Enable Modbus TCP in mySigen. LAN connection and firmware must permit read access.
- Register addresses are based on an unofficial Markdown transcription of Sigenergy Modbus V2.5. Address-offset conventions vary: default 0; try -1 only if confirmed necessary.
- Grid power positive = import, negative = export. ESS positive = charge, negative = discharge.
- EVDC 25kW Modbus monitoring/control is **not implemented**. Its protocol and safe local control path must be validated first.
- 3x25A is about 17.3kW total at 400V for balanced three-phase loading. Protection must use phase currents and native load balancing, not this app.
- Next milestones: tariff engine, rolling demand-window peak tracking, EV charging adapter, optimizer dry-run, verified failsafe, then controlled writes.
- App pairing uses a fixed device identity. This scaffold supports one plant per Homey.

Source: https://github.com/krzychdre/modbus-sigenergy/blob/main/Sigenergy_Modbus_Protocol_V2.5.md

## v0.2: Local EV charge schedule (planning only)

Open **App settings** to configure a minimum vehicle SoC (default **30%**) due by
**07:00 Europe/Stockholm** and optional individual day-of-week departure targets.
The default vehicle model assumes **75 kWh usable** and **92% charging efficiency**;
these are adjustable estimates, not verified Tesla specifications.

`lib/charging/planner.js` exports `planCharging({ now, currentSoc, config, prices, maxPowerKW })`.
Each price is `{ start: ISO8601, end: ISO8601, price: number }` in currency/kWh.
The planner selects cheaper intervals before each SoC deadline and returns a
read-only plan, estimated energy cost, and any unmet targets. Example:

```js
const { DEFAULTS, planCharging } = require('./lib/charging/planner');
const result = planCharging({
  now: new Date(), currentSoc: 25, config: DEFAULTS,
  prices: [ /* fetched quarter-hour Tibber prices */ ],
});
```

**Important limitations:** This version does NOT retrieve Tibber prices, read
EVDC SoC, command EVDC, account for Telge Nat demand tariffs, model household
load/solar/storage, or execute the plan. The scheduler is a preliminary
cost-minimizing charging planner, not a complete EMS. It assumes the car remains
connected and charging power is fixed. Price gaps and insufficient power are
reported as unreachable goals. Real-time planning must use current EVDC SoC,
verified available charger power, grid/phase limits and price coverage. Homey
must not replace hardware-level fuse protection or charger load balancing.

Run `npm test` to verify the planning logic. All Modbus operations remain read-only.

## v0.3: Solar allocation simulator (read-only)

`lib/charging/dispatch.js` adds a discrete, power-dependent solar surplus
allocator for the EV, home battery and grid export. It supports EV connection,
EV solar SoC cap, full home battery, configurable minimum/maximum charging power,
export opportunity value and an optional external power headroom constraint.
It compares **marginal value per stored kWh** rather than blindly charging the
home battery first. Run `npm test` to validate.

Example:

```js
const { allocateSolar } = require('./lib/charging/dispatch');
const decision = allocateSolar({
  surplusKW: 6, evConnected: true, evSoc: 45, homeSoc: 80,
  evValuePerKWh: 1.5, homeValuePerKWh: 1.1, exportPricePerKWh: 0.4,
});
```

**Not yet integrated into the Homey runtime:** this is an independently tested
planning module. It does not read EVDC registers, fetch Tibber prices, calculate
Telge Nat tariffs, learn efficiency curves, or issue Modbus writes. Efficiency
curves are *illustrative placeholders*, NOT measured SigenStor or EVDC values.
`gridHeadroomKW` is a planning input, NOT a fuse-protection mechanism; per-phase
protection must remain with certified local hardware. The EV's minimum 30% by
07:00 and optional weekday departure targets remain in the separate v0.2
charging planner. Full combined time-horizon optimization is future work.

## v0.4 — Tibber price cache and experimental EVDC monitoring

- Tibber GraphQL prices fetched on startup and every 30 minutes (when a token is configured), stored in Homey settings. Internet is required for refresh, not for using cached slots. **No guarantee of 48-hour coverage**; depends on publication time and provider.
- Add Tibber API token in App settings; if multiple Tibber homes, specify the exact home ID. Token stays in Homey settings and is sent only to Tibber. Price cache excludes token.
- Prices are read-only; app does **not** automatically execute plans. `this.homey.app.getPricePlan(currentSoc)` computes a dry-run plan from cached prices. No tariff/solar/battery dispatch coupling yet.
- EVDC probing is **disabled by default**. Enable it in the device settings only after checking the exact Modbus register layout for your firmware. Defaults are experimental 31502 (2 registers, unsigned W), 31504 (1 register, percent); wrong widths/scaling can yield invalid data. EVDC errors are logged separately and do not disable the main plant monitoring.
- No Modbus writes, no active EV control, no guarantee of hardware fuse protection. Hardware-level load balancing remains mandatory for 3x25A.
- Price cache can become stale; check `priceCache.fetchedAt`, and never plan against missing future intervals.


## v0.5 – Backup mode (read-only / advisory)

- Modbus input register **30009** (one 16-bit register) is polled with the existing plant snapshot. 0 = grid, 1/2 = island, all other values = unknown. Verify mapping against installed firmware.
- Island mode immediately suspends economic decisions and requests EV stop; SoC <25% requests critical Nibe mode. Requests are **not hardware commands**.
- Returning to grid requires five minutes of continuous successful readings. Modbus failures result in `unknown`, not a false grid-connected state.
- Homey Flow trigger `Backup mode changed` exposes `mode`, `ev_stop_requested`, `nibe_mode` tokens. These are advisory: no EVDC write registers or Nibe controls are wired.
- Status is persisted in Homey settings as `backupStatus`, with `controlApplied:false`. This is not proof that the car has stopped.
- Nibe F2120-16 is an outdoor unit; identify its VVM/SMO indoor controller before choosing a safe local heat-pump interface. myUplink requires internet and is not reliable as an outage safety mechanism. Do not cut mains to the heat pump with a smart relay.
- Homey and networking equipment must remain powered in island mode. EVDC must have an independently validated local fail-safe; Homey polling is not a safety-rated protective mechanism.
- On app restart, status begins as `unknown` until successful reads and restoration delay; automatic EV restart is not implemented.

## v0.6 — Optional local Nibe SMO S40 read-only monitoring

SMO S40 is the controller for the F2120-16. Enable Modbus TCP/IP on SMO S40, then configure the Homey **app settings** key `nibeHost` with the controller's local IP. Optional settings keys: `nibePort` (default 502), `nibeUnitId` (default 1), `nibeAddressOffset` (default 0). These keys can be entered through Homey developer settings; a dedicated Nibe settings UI is not yet provided. Polling occurs every 30 seconds only when `nibeHost` is set.

Reads input register IDs 1 (outdoor BT1), 8 (hot water BT7), 39 (supply BT25), 88 (return BT71), each assumed signed 16-bit /10. **Verify these addresses, scale, Modbus address offset and presence against the register export from your own SMO S40 before enabling.** Missing sensors can cause snapshot failure. Values are stored as `nibeStatus`, failures as `nibeError` in Homey settings. This does not create a separate Nibe device or capabilities.

`heat-pump-policy.js` computes *advisory* auxiliary-heat block reasons: demand tariff, grid limit, island/unknown. It never writes Nibe registers. `pollNibe` does not calculate tariff windows: your existing local Nibe tariff schedule stays in force. Island-mode actions remain unverified requests, not actual EVDC stop or heat pump control. Nibe's built-in frost protection and heater protection must not be bypassed. Never disable your existing schedule on the strength of this release.

This version adds NO Modbus writes and NO automatic load shedding. The outage detection uses the previously configured Sigenergy grid-mode register; verify its mapping on your firmware. Run `npm test` to validate the modules.


## v0.7: lokal historik (första implementation)

- Historik lagras i Homeys beständiga appinställningar, inte i en verifierad databas.
- 15-minutersaggregering av Sigenergy-effekt, SoC och valfri EVDC-data; 30 dagars retention.
- Dagsaggregat upp till 730 dagar, beräknade från 15-minutersposter.
- Ödriftslägesbyten loggas som händelser, maximalt 500 poster.
- Exportera JSON via appens inställningssida; spara filen utanför Homey.
- Energiberäkningar är approximativa trapezoidintegraler, inte debiteringsgrundande mätvärden.
- Effektavgift enligt Telge Nät beräknas ännu inte: tariffmodell och mätperiod måste verifieras.
- Ingen automatisk återimport och ingen säkerhetskopia utan användarens export.
- Homeys settingslagring är inte lämplig för en stor tidsseriedatabas; faktisk prestanda och lagringsutrymme måste mätas på hårdvaran.
- Ingen Modbus-skrivning har lagts till. Nibes befintliga effektavgiftsschema lämnas orört.


## v0.8 – preliminär effektavgiftsberäkning

`lib/demand-tariff.js` beräknar månadens högsta 15-minutersmedeleffekter inom ett
konfigurerat tidsfönster i tidszonen Europe/Stockholm. Antal toppar, krav på olika
dagar, veckodagar och kr/kW anges i Homeys inställningar. **Inga Telge Nät-värden
är förifyllda eller verifierade.** Inga styrkommandon skickas.

Beräkningen nås programmatiskt via `homey.app.getDemandCharge('2026-11')`.
Status `insufficient-data` betyder att antalet godkända intervall inte räcker.
Även status `provisional` är bara en uppskattning; full månadstäckning kontrolleras
inte ännu. Befintliga v0.7-intervall saknar `coverageMs` och utesluts avsiktligt.
`coverageMs` kräver minst 14 minuters sammanhängande observationer inom samma
15-minutersperiod. Enheten för `gridW` måste kontrolleras så att positivt värde
verkligen betyder import. För att undvika felaktiga energiberäkningar integreras
inte längre mätavstånd över kvartalsgränser; denna enkla integration kan därför
underskatta energi, och måste förbättras före fakturajämförelse.

Detta är en beräkningsmodul och inställningsformulär, inte en färdig graf eller
fakturaverifierad tariffmotor.

## v0.9 – gränssnitt och fördröjd Tibber-publicering

Inställningssidan har nu flikarna **Översikt**, **Elpriser**, **Historik** och **Inställningar**.
Översikten visar senast sparade 15-minutersmedelvärden (inte live-data), Nibes BT1,
reservkraftsstatus och ett enkelt diagram. Saknade data visas som streck, inte som noll.
Prisvyn visar cache-status och om morgondagens priser har publicerats.

Tibber-kontrollen sker var 15:e minut efter 13:00 svensk tid om morgondagens
priser saknas, annars högst en gång i timmen. Misslyckad hämtning behåller
senast lyckade cache. Publiceringstidpunkten är inte garanterad.

Gränssnittet ligger i Homeys **appinställningar**, inte i en Homey Dashboard-widget.
All styrning är fortfarande read-only/simulering. Tariffparametrar är inte
verifierade mot Telge Nät. Vyn är inte testad på fysisk Homey Pro.


## v0.10 – inlärningsläge och gränssnitt
- Inlärningsläge är **alltid aktivt** i denna version. Ingen kodväg för Modbus-skrivning finns; UI kan inte aktivera styrning.
- Inställningssidan har fliken **Optimering**, ett konservativt peak shaving-scenario och inställningar för batteri, effekt och reserv.
- Nibe TCP-värd, port, Unit ID och registeroffset går att ställa in i UI. SigEnergy-IP, port och EVDC-register konfigureras i enhetens inställningar.
- Simulatorn uppskattar underliggande last med `gridWh + essWh` (positiv ESS = laddning) och antar **ingen återladdning**. Den kan därför inte påstå sig finna ett ekonomiskt optimum eller lova att en effekttopp undviks. Historisk batteridrift och okända laster begränsar precisionen.
- Befintligt Nibe-tariffs schema förblir oförändrat. EVDC-stopp och Nibe-blockering vid ödrift är enbart begärda åtgärder i logiken, **inte utförda**.
- Lagring sker i Homey settings, inte i en extern databas. Gör manuella exporter; ingen garanterad backup eller återimport ännu.
- Tariffvärden måste verifieras med Telge Nät.

## v0.11 – batteritelemetri och 0,1 kW

- Simulatorns standardsteg för effekttak är 0,1 kW; inställningsformuläret accepterar 0,1 kW.
- Kapacitet och SoC hämtas från befintlig plant-snapshot. Valfria Modbus-register för effektgränser, SoC-cutoffs, SoH och tillgänglig energi avläses var femte minut. Fel i valfria register hindrar inte basavläsningen.
- Inställningen **Använd aktuella batterivärden** väljer automatiska värden med högst tio minuters ålder, annars manuella parametrar. Batteriets effektgränser kan endast sänka simulerad maximal effekt.
- **Varning:** Registerstorlek, skalning och firmwarestöd för valfria register är ännu inte verifierade mot fysisk utrustning. Resultaten är endast rådgivande. Inga Modbus-skrivningar finns.
- Optimeringen är fortfarande en förenklad simulering utan återladdning, temperaturprognos eller verifierad Telge Nät-tariff.

## v0.13 – Dashboard widget and advanced advisory replay

- `widgets/energy-overview/` contains a **Homey Dashboard widget candidate** (2x height) showing grid, solar, SoC and Nibe outdoor temperature from read-only local settings. Widget packaging and Homey Dashboard runtime compatibility **have not been verified on a Homey**. It uses the last completed 15-minute history slot, **not live telemetry**, and marks stale data.
- `lib/optimization/advanced-simulator.js` adds an isolated **advisory-only** counterfactual replay with explicit optional surplus charging, max charge/discharge power, SoC floor, battery wear estimate, and optional timestamp-matched electricity prices. Exposed through `app.getAdvancedOptimizationPreview(options)` for future UI/API wiring. The settings page still runs the older conservative no-recharge simulator; the advanced model is **not yet connected to the UI**.
- No PV surplus is inferred from production history: measured production is not equivalent to *unused* PV energy. No automatic battery recharging or market arbitrage is invented. Prices are not silently replaced with zero if missing. No official Telge Nat tariff has been validated.
- All modes remain read-only. No Modbus writes or autonomous dispatch.
- Run `npm test` to execute the Node test suite. Homey installation and physical hardware tests are still required.

## v0.14 – Dashboard-rekommendationer
Widgeten visar ett preliminärt effekttak (0,1 kW) och en batterireserv från den läsbaserade 15-minuterssimulatorn. Resultatet sparas i Homey settings var 15:e minut, och visas inte om det är äldre än 35 minuter. Vid otillräckliga data visas inga rekommenderade siffror. Detta är **inte** en verifierad optimering av Telge Näts fem högsta timtoppar; tariffens exakta regler återstår att verifiera. Inga styrkommandon skickas.


## v0.15 – Five-peak hourly tariff estimate

Dashboard shows provisional monthly five-peak hourly mean and estimated fee when a manually verified tariff is configured. Requires four complete quarter-hour energy integrals per clock hour; supports distinct-day selection and optional months. No savings estimate until a matching counterfactual hourly model is available. No control writes. Tariff holiday exclusions, official pricing and full-month coverage remain unverified.


## v0.16 — femtoppsoptimering (preliminär)

- Samma timbaserade femtoppsmodell används för historisk baslinje och kontrafaktisk simulering.
- Dashboard visar simulerad effektavgift och möjlig besparing på effektdelen när fem kompletta timmar finns.
- Rangordnar genomförbara scenarier efter möjlig effektbesparing; full ekonomisk rangordning kräver kompletta matchade elpriser och energibaslinje.
- Ingen automatisk styrning. Resultat är preliminära och inte fakturakorrekt eller framtidsprognos.
- Modellen behöver fortfarande verifierade tariffregler, inklusive olika dagar och helgdagar, och faktisk driftdata.


## v0.17: marginalkostnadsmodell (endast beräkning)

`lib/pricing/cost-model.js` ger separata marginalpriser för Tibber-inköp
(inklusive moms) och Tibber-försäljning (ersättning), med konfigurerbar
energiskatt, rörlig nätöverföring, nätnytta och eventuell exportavgift.
Modellen kan beräkna kostnad/intäkt från signerade nätenergivärden och
lägga till femtoppsavgift och batterislitage utan dubbelräkning.

**Integrationsstatus:** Kostnadsmodellen är en separat, testad modul. Den
är ännu INTE ansluten till Tibbers faktiska produktionspriser, Homey
Dashboard eller scenariorankningen. Tibbers befintliga GraphQL-fråga
hämtar enbart inköpspriser. Det finns ingen verifierad API-åtkomst till
försäljningsavtalets faktiska ersättning. Tills båda prisserierna är
verifierade ska ingen fullständig ekonomisk rekommendation visas.

Inga skatte-/tariffvärden hårdkodas som gällande: alla värden måste
konfigureras från aktuellt avtal och prislista. Effektavgift och fasta
avgifter ska inte ingå i marginalpris per kWh. Fortsatt läsläge.

## Open-source development status

**Experimental / learning mode only.** This release has not been verified on a
physical Homey Pro, Sigenergy inverter, EVDC charger, or Nibe heat pump.
Modbus addresses and scaling must be verified against hardware and current
vendor documentation. No automated control should be assumed safe or supported.
The Telge Nät five-peak tariff and energy price components require verification
against the actual contract and current price lists. Do not rely on estimated
savings as billing-accurate.

### Development

```sh
npm install
npm test
```

The CI workflow runs unit tests and checks that `app.json` and `package.json`
versions match. Do not commit Tibber API tokens, private telemetry or local
configuration exports.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
Licensed under the [MIT License](LICENSE).
