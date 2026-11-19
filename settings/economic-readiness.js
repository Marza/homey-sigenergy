(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EconomicReadinessSettings = factory();
})(globalThis, function () {
  'use strict';
  const H = 3600000,
    Q = 900000;
  const labels = {
    energyQuarters: [
      'Nätenergi och riktningsdata',
      'Samla kompletta nya energikvartar. En timreferens från Tibber ersätter inte kvartshistoriken.',
    ],
    batteryCoverageQuarters: [
      'Batterienergi och täckning',
      'Separat batteritäckning behövs. Korta nya luckor kan få märkta räknarestimat; äldre luckor utan räknarpar förblir okända.',
    ],
    contractQuarters: [
      'Daterade avtalsvillkor',
      'Kontrollera och publicera verkliga giltighetsdatum i steg 2. Kontrollerat datum används inte som avtalsstart.',
    ],
    purchasePriceQuarters: [
      'Historiska köppriser',
      'Kontrollera Tibberhistoriken i steg 1. Hämtningen kan vara fördröjd.',
    ],
    productionPriceQuarters: [
      'Historiska säljpriser',
      'Kontrollera Tibbers produktionshistorik i steg 1. Köppriset ersätter aldrig säljpriset.',
    ],
    solarCoverageQuarters: [
      'Separat solenergitäckning',
      'Samla nya kvartar med separat PV-täckning; gammal täckning kan inte antas.',
    ],
    solarEnergyQuarters: [
      'Solenergivärden',
      'Perioden behöver giltiga, icke-negativa solenergivärden. Noll är tillåtet.',
    ],
    evCoverageQuarters: [
      'Mättäckning för billaddning',
      'Samla kompletta kvartar för de aktiverade laddarna. En uppmätt nolla är giltig. Tid utan mätning är okänd.',
    ],
    knownEvChargingQuarters: [
      'Registrerad aktivitet från billaddare',
      'Modellen kräver en period utan uppmätt laddning eller urladdning. Bekräfta även perioden själv.',
    ],
    inconsistentSolarQuarters: [
      'Sol-/nätbalans',
      'Nät-, batteri- och soldata måste räcka för en konsekvent balans. Saknat underlag kan inte bedömas.',
    ],
  };
  const gates = {
    tibberHome: [
      'Tibberhem och mätpunkt',
      'Bekräfta samma mätpunkt i steg 1 och kontrollera Tibber-anslutningen.',
    ],
    priceCache: [
      'Lokal historisk prisdata',
      'Kontrollera historikhämtningen i steg 1. Ogiltig eller felbunden cache används inte.',
    ],
    datedTerms: [
      'Sparade kostnadsversioner',
      'Läs om versionerna i steg 2. Publicera endast kontrollerade giltighetsdatum.',
    ],
    history: [
      'Läsbar lokal historik',
      'Historiken kunde inte bedömas. Kontrollera diagnostiken och försök igen.',
    ],
    solarPlant: ['En SigEnergy-anläggning', 'Sol/bil-modellen kräver exakt en parad anläggning.'],
    chargingConfig: [
      'Sparade bilinställningar',
      'Spara och kontrollera bilens kapacitet, effekt, verkningsgrad och grundmål under Elbil.',
    ],
  };
  function validReport(r, hours, mode) {
    if (
      !r ||
      !['complete', 'incomplete'].includes(r.status) ||
      r.mode !== mode ||
      r.advisoryOnly !== true ||
      r.controlApplied !== false ||
      r.financiallyComparable !== false ||
      r.rankingBasis !== 'none' ||
      r.modelValidated !== false ||
      r.demandEvaluated !== false ||
      ![r.from, r.to, r.checkedAt].every(Number.isSafeInteger) ||
      r.from < 0 ||
      r.to - r.from !== hours * H ||
      r.to !== Math.floor(r.checkedAt / H) * H ||
      !r.checks ||
      !Array.isArray(r.gates)
    )
      return false;
    const keys = Object.keys(labels).slice(0, mode === 'solar-ev' ? undefined : 5);
    const gateKeys = Object.keys(gates).slice(0, mode === 'solar-ev' ? 6 : 4);
    if (
      Object.keys(r.checks).length !== keys.length ||
      r.gates.length !== gateKeys.length ||
      !gateKeys.every(
        (key) =>
          r.gates.filter((g) => g?.key === key && ['complete', 'unavailable'].includes(g.state))
            .length === 1,
      )
    )
      return false;
    for (const key of keys) {
      const c = r.checks[key];
      if (
        !c ||
        !['complete', 'missing', 'unavailable'].includes(c.state) ||
        c.expectedQuarters !== hours * 4 ||
        !Array.isArray(c.ranges) ||
        c.ranges.length > 24
      )
        return false;
      if (c.state === 'unavailable') {
        if (
          c.missingQuarters !== null ||
          c.affectedHours !== null ||
          c.ranges.length ||
          c.rangeCount !== 0 ||
          c.rangesTruncated !== false
        )
          return false;
        continue;
      }
      if (
        !Number.isInteger(c.missingQuarters) ||
        c.missingQuarters < 0 ||
        c.missingQuarters > hours * 4 ||
        !Number.isInteger(c.affectedHours) ||
        c.affectedHours < 0 ||
        c.affectedHours > hours ||
        c.affectedHours < Math.ceil(c.missingQuarters / 4) ||
        c.affectedHours > c.missingQuarters ||
        (c.missingQuarters > 0 && c.ranges.length === 0) ||
        !Number.isInteger(c.rangeCount) ||
        c.rangeCount < c.ranges.length ||
        c.rangeCount > c.missingQuarters ||
        c.rangesTruncated !== c.rangeCount > c.ranges.length ||
        (c.state === 'complete') !== (c.missingQuarters === 0) ||
        (c.missingQuarters === 0) !== (c.affectedHours === 0)
      )
        return false;
      let previous = r.from,
        count = 0;
      for (const gap of c.ranges) {
        if (
          ![gap?.from, gap?.to].every(Number.isSafeInteger) ||
          gap.from < previous ||
          gap.to <= gap.from ||
          gap.to > r.to ||
          gap.from % Q ||
          gap.to % Q
        )
          return false;
        previous = gap.to;
        count += (gap.to - gap.from) / Q;
      }
      if (count > c.missingQuarters || (!c.rangesTruncated && count !== c.missingQuarters))
        return false;
    }
    const complete =
      r.gates.every((g) => g.state === 'complete') &&
      keys.every((key) => r.checks[key].state === 'complete');
    return r.dataComplete === complete && (r.status === 'complete') === complete;
  }
  function bind(Homey, document = globalThis.document) {
    const panel = document.getElementById('econ-readiness-panel');
    if (!panel?.querySelectorAll) return;
    const el = (id) => document.getElementById('econ-' + id),
      button = el('check-data'),
      status = el('data-status'),
      list = el('data-checks');
    let generation = 0,
      requestTimer,
      expiryTimer;
    const clear = (text = 'Period eller underlag ändrat. Kontrollera underlaget på nytt.') => {
      generation++;
      clearTimeout(requestTimer);
      clearTimeout(expiryTimer);
      button.disabled = false;
      list.replaceChildren();
      status.textContent = text;
    };
    for (const id of ['hours', 'solar-enabled'])
      for (const event of ['input', 'change']) el(id).addEventListener(event, () => clear());
    for (const id of [
      'econ-publish',
      'econ-import',
      'econ-refresh',
      'trade-confirm',
      'trade-refresh',
      'saveTibber',
      'saveCostContract',
      'saveTariff',
      'save',
      'restoreHistory',
    ])
      document.getElementById(id)?.addEventListener('click', () => clear());
    const date = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'shortOffset',
    });
    const node = (tag, text) => {
      const n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      return n;
    };
    button.addEventListener('click', () => {
      clear('Läser lokalt sparat underlag…');
      const current = generation,
        mode = el('solar-enabled').checked ? 'solar-ev' : 'battery',
        raw = el('hours').value.trim(),
        hours = Number(raw);
      if (
        !/^\d+$/.test(raw) ||
        !Number.isInteger(hours) ||
        hours < 1 ||
        hours > (mode === 'solar-ev' ? 168 : 768)
      ) {
        status.textContent =
          'Välj ett helt antal timmar: 1–' + (mode === 'solar-ev' ? '168' : '768') + '.';
        return;
      }
      button.disabled = true;
      requestTimer = setTimeout(() => {
        if (current === generation)
          clear(
            'Kontrollen fick inget svar. Försök igen; ingen beräkning eller hämtning startades.',
          );
      }, 15000);
      let settled = false;
      const receive = (error, r) => {
        if (current !== generation || settled) return;
        settled = true;
        clearTimeout(requestTimer);
        button.disabled = false;
        if (
          error ||
          !validReport(r, hours, mode) ||
          r.to + H <= Date.now() ||
          r.checkedAt > Date.now() + 5 * 60000
        ) {
          clear('Underlaget kunde inte bedömas. Försök igen. Inga luckor antas vara täckta.');
          return;
        }
        status.textContent =
          (r.dataComplete
            ? 'Data för grundkontrollen är täckta.'
            : 'Underlaget är ofullständigt eller kan inte bedömas.') +
          ' Period ' +
          date.format(r.from) +
          ' – ' +
          date.format(r.to) +
          ' (slut exkluderat). Kontrollerat ' +
          date.format(r.checkedAt) +
          '.';
        if (r.counterRecoveredQuarters)
          list.appendChild(
            node(
              'li',
              r.counterRecoveredQuarters +
                ' kvart innehåller energiestimat från Sigenergys räknare. Ursprungliga effektprov har inte återskapats.',
            ),
          );
        for (const g of r.gates) {
          const row = node('li');
          row.className = 'readiness-row';
          row.appendChild(
            node(
              'strong',
              gates[g.key][0] +
                ': ' +
                (g.state === 'complete' ? 'finns/bekräftat' : 'behöver kontrolleras'),
            ),
          );
          if (g.state !== 'complete') row.appendChild(node('p', gates[g.key][1]));
          list.appendChild(row);
        }
        for (const [key, c] of Object.entries(r.checks)) {
          const row = node('li');
          row.className = 'readiness-row';
          row.appendChild(node('strong', labels[key][0]));
          row.appendChild(
            node(
              'p',
              c.state === 'unavailable'
                ? 'Kan inte bedömas; antal luckor är okänt.'
                : c.state === 'complete'
                  ? 'Inga blockerande dataluckor i grundkontrollen.'
                  : c.missingQuarters +
                    ' kvart saknas eller är blockerade (' +
                    (c.missingQuarters / 4).toLocaleString('sv-SE') +
                    ' timmar), i ' +
                    c.affectedHours +
                    ' berörda klocktimmar.',
            ),
          );
          if (c.state !== 'complete') row.appendChild(node('p', labels[key][1]));
          if (c.ranges.length) {
            const detail = node('details'),
              ranges = node('ul');
            detail.appendChild(
              node(
                'summary',
                'Visa perioder' +
                  (c.rangesTruncated ? ' (' + c.ranges.length + ' av ' + c.rangeCount + ')' : ''),
              ),
            );
            for (const gap of c.ranges)
              ranges.appendChild(
                node(
                  'li',
                  date.format(gap.from) + ' – ' + date.format(gap.to) + ' (slut exkluderat)',
                ),
              );
            detail.appendChild(ranges);
            row.appendChild(detail);
          }
          list.appendChild(row);
        }
        expiryTimer = setTimeout(
          () => {
            if (current === generation)
              clear('En ny hel timme har avslutats. Kontrollera den nya perioden på nytt.');
          },
          Math.min(H, r.to + H - Date.now()),
        );
      };
      try {
        Homey.api('POST', '/economics/readiness', { hours, mode }, receive);
      } catch {
        receive(new Error('transport-unavailable'));
      }
    });
  }
  return { bind, validReport };
});
