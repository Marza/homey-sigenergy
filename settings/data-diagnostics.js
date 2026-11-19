(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DataDiagnosticsSettings = factory();
})(globalThis, function () {
  'use strict';
  const labels = {
    'app-started': 'Appen startade; mätkedjan börjar om',
    'app-stopped': 'Appen stoppades',
    'reader-started': 'Anslutningsläsaren startade',
    'connection-changed': 'Anslutningsinställningar eller mätkälla ändrades',
    'invalid-sample': 'Ogiltigt eller saknat mätvärde',
    'sample-delay': 'För lång tid mellan giltiga mätvärden',
    'counter-reset': 'Energiräknaren minskade och fick en ny startpunkt',
    'modbus-timeout': 'Modbus svarade inte i tid',
    'modbus-unreachable': 'Modbus-adressen kunde inte nås',
    'modbus-refused': 'Modbus-anslutningen avvisades',
    'modbus-read-error': 'Modbus-avläsningen misslyckades',
    'counter-recovery-failed':
      'Räknaråterhämtningen kunde inte genomföras; ordinarie avläsning fortsätter',
    'counter-gap-recovered':
      'Kort energilucka kompletterades från Sigenergys kWh-räknare (uppskattning)',
    'plant-processing-error': 'Bearbetning eller publicering av anläggningsdata misslyckades',
    'off-grid': 'Nätenergin pausades eftersom nätläge inte var on-grid',
    'slow-poll': 'Ett avläsningsvarv tog mer än 60 sekunder',
    'history-write-failed': 'Historiken kunde inte sparas; bufferten behölls',
    'history-write-recovered': 'Historiken kunde sparas igen',
    'history-imported': 'Historik återlästes; mätkedjan börjar om',
    'prices-updated': 'Tibbers prisunderlag hämtades komplett för begärd period',
    'prices-partial': 'Tibber saknade priser i svaret',
    'prices-rate-limited': 'Tibber begränsade anropsfrekvensen',
    'prices-authorization': 'Tibber nekade behörighet',
    'prices-request-failed': 'Tibbers prishämtning misslyckades',
  };
  const sources = {
    app: 'App',
    plant: 'Anläggning',
    grid: 'Nät',
    battery: 'Batteri',
    solar: 'Sol',
    ev: 'Bil (EVDC)',
    evac: 'AC-laddare (EVAC)',
    household: 'Husets förbrukning utan billaddning',
    storage: 'Lagring',
    prices: 'Tibber',
  };
  const time = (value) =>
    Number.isSafeInteger(value)
      ? new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Europe/Stockholm',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'shortOffset',
        }).format(value)
      : '–';
  const nonnegative = (n) => Number.isSafeInteger(n) && n >= 0;
  function validQuality(q, from, to) {
    if (
      q?.schema !== 1 ||
      q.from !== from ||
      q.to !== to ||
      !nonnegative(q.totalMs) ||
      q.totalMs !== to - from ||
      q.totalMs === 0 ||
      !q.channels ||
      !q.hourlyGrid
    )
      return false;
    for (const key of ['grid', 'battery', 'solar', 'ev', 'evac', 'household']) {
      const c = q.channels[key];
      if (!c || typeof c.available !== 'boolean') return false;
      const values = [c.observedMs, c.counterEstimatedMs, c.unknownMs];
      if (
        c.available
          ? !values.every(nonnegative) || values.reduce((a, b) => a + b, 0) !== q.totalMs
          : values.some((n) => n !== null)
      )
        return false;
    }
    const household = q.channels.household;
    if (
      household.energyWh !== null &&
      (!Number.isFinite(household.energyWh) ||
        household.energyWh < 0 ||
        !(household.observedMs + household.counterEstimatedMs > 0))
    )
      return false;
    const h = q.hourlyGrid;
    const values = [h.sampledHours, h.withCounterEstimateHours, h.tibberHours, h.unknownHours];
    return (
      typeof h.available === 'boolean' &&
      h.from === Math.floor(from / 3600000) * 3600000 &&
      h.to === Math.floor(to / 3600000) * 3600000 &&
      h.totalHours === (h.to - h.from) / 3600000 &&
      nonnegative(h.totalHours) &&
      (h.available
        ? values.every(nonnegative) && values.reduce((a, b) => a + b, 0) === h.totalHours
        : values.every((n) => n === null)) &&
      ['grid', 'battery', 'solar', 'ev', 'evac', 'household'].every(
        (k) => q.channels[k].available === q.channels.grid.available,
      ) &&
      (!h.available || q.channels.grid.available)
    );
  }
  function duration(ms) {
    if (ms > 0 && ms < 1000) return '<1 s';
    const seconds = Math.floor(ms / 1000);
    return [
      seconds >= 3600 ? Math.floor(seconds / 3600) + ' h' : '',
      seconds >= 60 ? Math.floor((seconds % 3600) / 60) + ' min' : '',
      seconds % 60 || seconds === 0 ? (seconds % 60) + ' s' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  // Truncate: positive unknown coverage must never round observed coverage up to 100%.
  const percent = (ms, total) =>
    new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(
      Math.floor((ms / total) * 10000) / 100,
    ) + ' %';
  function bind(Homey) {
    const el = (id) => document.getElementById('gap-' + id);
    let generation = 0;
    function clear() {
      generation++;
      el('results').replaceChildren();
      el('status').textContent = 'Perioden ändrades. Uppdatera diagnostiken.';
      el('refresh').disabled = false;
    }
    el('hours').onchange = clear;
    el('refresh').onclick = async () => {
      const current = ++generation;
      el('results').replaceChildren();
      el('refresh').disabled = true;
      el('status').textContent = 'Hämtar diagnostik…';
      try {
        const report = await new Promise((resolve, reject) => {
          let done = false;
          const timer = setTimeout(() => {
            if (!done) {
              done = true;
              reject(Error('timeout'));
            }
          }, 15000);
          Homey.api(
            'POST',
            '/diagnostics/data-gaps',
            { hours: Number(el('hours').value) },
            (error, result) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              if (error) reject(error);
              else resolve(result);
            },
          );
        });
        if (current !== generation) return;
        if (
          report?.schema !== 1 ||
          !report.gaps ||
          !report.prices ||
          !Array.isArray(report.events) ||
          !report.storage ||
          !Number.isSafeInteger(report.from) ||
          !Number.isSafeInteger(report.to) ||
          !validQuality(report.quality, report.from, report.to)
        )
          throw Error('invalid-report');
        const paragraph = (parent, text) => {
          const p = document.createElement('p');
          p.textContent = text;
          parent.appendChild(p);
        };
        const section = (title) => {
          const box = document.createElement('section');
          box.className = 'settingsGroup';
          const h = document.createElement('h4');
          h.textContent = title;
          box.appendChild(h);
          el('results').appendChild(box);
          return box;
        };
        const showRanges = (title, group, unit, coverage) => {
          if (!group || !Number.isInteger(group.missing) || !Array.isArray(group.ranges))
            throw Error('invalid-report');
          const box = section(title);
          paragraph(
            box,
            group.available === false
              ? 'Historiken kunde inte läsas.'
              : group.missing + ' saknade eller ofullständiga ' + unit + '.',
          );
          if (coverage) {
            if (!coverage.available) paragraph(box, 'Tidstäckningen är inte tillgänglig.');
            else {
              if (coverage.energyWh !== undefined) {
                const kWh =
                  coverage.energyWh === null
                    ? 'saknas'
                    : (coverage.energyWh / 1000).toLocaleString('sv-SE', {
                        maximumFractionDigits: 2,
                      }) + ' kWh';
                paragraph(box, 'Energi under täckt tid: ' + kWh + '.');
              }
              const parts = [
                ['Observerat', 'observedMs', 'observed'],
                ['Räknarestimat', 'counterEstimatedMs', 'estimated'],
                ['Okänd tid', 'unknownMs', 'unknown'],
              ];
              const bar = document.createElement('div');
              bar.className = 'coverage-bar';
              bar.setAttribute('aria-hidden', 'true');
              for (const [label, key, className] of parts) {
                const segment = document.createElement('span');
                segment.className = 'coverage-' + className;
                segment.style.width = (coverage[key] / report.quality.totalMs) * 100 + '%';
                bar.appendChild(segment);
                paragraph(
                  box,
                  label +
                    ': ' +
                    duration(coverage[key]) +
                    ' (' +
                    percent(coverage[key], report.quality.totalMs) +
                    ').',
                );
              }
              box.appendChild(bar);
            }
          }
          if (group.ranges.length) {
            const details = document.createElement('details');
            details.className = 'settings-details';
            const summary = document.createElement('summary');
            summary.textContent = 'Visa perioder och registrerade händelser';
            details.appendChild(summary);
            const list = document.createElement('ul');
            for (const r of group.ranges) {
              if (
                !Number.isSafeInteger(r.from) ||
                !Number.isSafeInteger(r.to) ||
                !Array.isArray(r.reasons)
              )
                throw Error('invalid-report');
              const li = document.createElement('li');
              li.textContent =
                time(r.from) +
                ' – ' +
                time(r.to) +
                '. ' +
                (r.reasons.length
                  ? 'Registrerat vid perioden: ' +
                    r.reasons.map((code) => labels[code] || 'Okänd händelse').join('; ')
                  : 'Ingen orsak registrerad för perioden.');
              list.appendChild(li);
            }
            details.appendChild(list);
            box.appendChild(details);
            if (group.truncated)
              paragraph(
                box,
                'Visar de första 100 perioderna. Välj en kortare period för fler detaljer.',
              );
          }
        };
        for (const source of ['grid', 'battery', 'solar', 'ev', 'evac', 'household'])
          showRanges(
            sources[source],
            report.gaps[source],
            source === 'household' ? 'kvartar' : 'råa kvart',
            report.quality.channels[source],
          );
        showRanges('Köppriser från Tibber', report.prices.consumption, 'hela timmar');
        showRanges('Säljpriser från Tibber', report.prices.production, 'hela timmar');
        const hourly = report.quality.hourlyGrid;
        const recovered = section('Nätenergi – källor för hela timmar');
        paragraph(
          recovered,
          time(hourly.from) +
            ' – ' +
            time(hourly.to) +
            '. Totalt ' +
            hourly.totalHours +
            ' avslutade timmar.',
        );
        if (!hourly.available) paragraph(recovered, 'Timunderlaget kunde inte kontrolleras.');
        else {
          paragraph(
            recovered,
            'Enbart observerade Sigenergy-kvart: ' +
              hourly.sampledHours +
              ' timmar. Timmar med räknarestimat: ' +
              hourly.withCounterEstimateHours +
              '. Timmar kompletterade från Tibber: ' +
              hourly.tibberHours +
              '. Okända timmar: ' +
              hourly.unknownHours +
              '.',
          );
        }
        if (report.recovery)
          paragraph(
            recovered,
            'Kvart med räknaråterhämtning: ' + report.recovery.counterQuarters + '.',
          );
        paragraph(
          recovered,
          'Varje timme räknas en gång. En timme med räknarestimat kan också innehålla observerad tid. Tibber fyller endast nätets timunderlag, inte tidstäckningen för nät, batteri eller sol.',
        );
        if (report.recovery?.crossQuarterQuarters > 0)
          paragraph(
            recovered,
            'Kvart med fördelning över kvartgräns: ' +
              report.recovery.crossQuarterQuarters +
              '. Energin har fördelats efter saknad tid. Den exakta energifördelningen mellan kvarten är okänd.',
          );
        const prices = section('Tibbers hämtningsläge');
        const priceStates = {
          ok: 'Komplett svar vid senaste hämtning',
          partial: 'Ofullständigt svar',
          'waiting-for-energy': 'Väntar på energihistorik',
          fetching: 'Hämtning pågår',
          'rate-limited': 'Anropsbegränsning',
          'authorization-required': 'Behörighet saknas',
          'network-error': 'Nätverksfel',
          'upstream-unavailable': 'Tibber tillfälligt otillgängligt',
          'history-fetch-failed': 'Hämtningen misslyckades',
          'invalid-history': 'Svaret kunde inte användas',
        };
        paragraph(prices, priceStates[report.prices.status] || 'Prisstatus saknas.');
        paragraph(
          prices,
          'Prisperiod: ' + time(report.prices.from) + ' – ' + time(report.prices.to) + '.',
        );
        paragraph(
          prices,
          'Senast hämtat: ' +
            time(report.prices.fetchedAt) +
            '. Nästa försök tidigast: ' +
            time(report.prices.nextAttemptAt) +
            '. Tibber kan rapportera priser med fördröjning.',
        );
        const storage = section('Lagring och orsakslogg');
        paragraph(
          storage,
          report.storage.readable
            ? 'Historiken kan läsas. Sparad: ' +
                time(report.storage.lastSavedAt) +
                '. Revision: ' +
                (report.storage.revision ?? '–') +
                '. Storlek: ' +
                Math.round(report.storage.bytes / 1024) +
                ' KiB av ' +
                Math.round(report.storage.limitBytes / 1024) +
                ' KiB. Buffrade kvart: ' +
                report.storage.pendingQuarters +
                '.'
            : 'Historiken kunde inte läsas.',
        );
        paragraph(
          storage,
          'Orsakslogg från ' +
            time(report.recordingSince) +
            '. ' +
            (report.journalHealthy
              ? 'Loggens lagring är tillgänglig.'
              : 'Orsaksloggen kunde inte läsas eller sparas; visningen kan vara ofullständig.'),
        );
        if (report.droppedEvents)
          paragraph(storage, 'Äldre händelser har tagits bort på grund av loggens storleksgräns.');
        const events = section('Registrerade händelser i vald period');
        if (!report.events.length)
          paragraph(events, 'Inga registrerade händelser. Äldre luckor får ingen antagen orsak.');
        else {
          const details = document.createElement('details');
          details.className = 'settings-details';
          const summary = document.createElement('summary');
          summary.textContent = 'Visa registrerade händelser (' + report.events.length + ')';
          details.appendChild(summary);
          const list = document.createElement('ul');
          for (const e of report.events) {
            const li = document.createElement('li');
            li.textContent =
              time(e.from) +
              (e.to !== e.from ? ' – ' + time(e.to) : '') +
              ': ' +
              (sources[e.source] || 'Okänd källa') +
              ' — ' +
              (labels[e.reason] || 'Okänd händelse');
            list.appendChild(li);
          }
          details.appendChild(list);
          events.appendChild(details);
        }
        el('status').textContent =
          'Diagnostik hämtad ' +
          time(report.generatedAt) +
          '. Mätkvart: ' +
          time(report.from) +
          ' – ' +
          time(report.to) +
          '. Priser kontrolleras för hela avslutade timmar.';
      } catch {
        if (current === generation) {
          el('results').replaceChildren();
          el('status').textContent =
            'Diagnostiken kunde inte hämtas. Försök igen; tidigare resultat har dolts.';
        }
      } finally {
        if (current === generation) el('refresh').disabled = false;
      }
    };
  }
  return { bind, validQuality, duration, percent };
});
