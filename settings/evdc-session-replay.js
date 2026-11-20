(function (root) {
  'use strict';
  const reasons = {
    'no-evdc-session': 'Inget DC-laddpass hittades i de senaste sju dagarna.',
    'evdc-session-start-unconfirmed':
      'Passet saknar en uppmätt kvart utan DC-laddning före starten.',
    'evdc-session-end-unconfirmed': 'Vänta på en hel sparad kvart utan DC-laddning efter passet.',
    'incomplete-evdc-session': 'Passet har saknade kvartsvärden eller registrerad DC-urladdning.',
    'evdc-session-changed': 'Laddpasset har ändrats. Hämta senaste pass på nytt.',
    'invalid-evdc-request':
      'Ange tidigare start i steg om 15 minuter och en verkningsgrad på 50–100 %.',
    'evdc-window-blocked': 'Jämförelsen kan inte beräknas för vald starttid.',
    'invalid-history': 'Historiken kunde inte läsas.',
    'invalid-household-import-limits': 'Kontrollera importgränserna under Inställningar → Hushåll.',
  };
  const date = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
  });
  const number = new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const time = (ms) => date.format(ms);
  const fmt = (n) => number.format(n);
  const delta = (n) => (Math.abs(n) < 0.005 ? fmt(0) : (n > 0 ? '+' : '') + fmt(n));
  function bind(Homey) {
    const el = (key) => document.getElementById('evdc-replay-' + key);
    const clear = () => el('results').replaceChildren();
    const paragraph = (text) => {
      const p = document.createElement('p');
      p.textContent = text;
      el('results').appendChild(p);
    };
    let session = null;
    let version = 0;
    function send(body, render) {
      const request = ++version;
      clear();
      el('status').textContent = 'Läser historiken …';
      const timer = setTimeout(() => {
        if (version !== request) return;
        version++;
        el('status').textContent = 'Homey svarade inte. Försök igen.';
      }, 15000);
      Homey.api('POST', '/economics/evdc-session-replay', body, (error, result) => {
        clearTimeout(timer);
        if (version !== request) return;
        if (error) {
          el('status').textContent = 'Historiken kunde inte läsas. Försök igen.';
          return;
        }
        if (result?.status === 'unavailable') {
          el('status').textContent = reasons[result.reason] || 'Laddpasset kunde inte bedömas.';
          for (const [key, label] of [
            ['missing', 'Saknad nätmätning'],
            ['overlaps', 'Saknad DC-mätning eller annan DC-aktivitet'],
          ]) {
            if (result[key]?.length)
              paragraph(
                label + ' i ' + result[key].length + ' kvart, från ' + time(result[key][0]) + '.',
              );
          }
          return;
        }
        try {
          render(result);
        } catch {
          clear();
          el('status').textContent = 'Homey gav ett ogiltigt svar.';
        }
      });
    }
    el('find').onclick = () => {
      session = null;
      el('session').textContent = '';
      el('options').hidden = true;
      send({}, (result) => {
        if (result?.status !== 'session') throw Error('Invalid session');
        const { start, end, energyKWh } = result.session;
        if (![start, end, energyKWh].every(Number.isFinite)) throw Error('Invalid session');
        session = result.session;
        el('session').textContent =
          time(start) + '–' + time(end) + ' · ' + fmt(energyKWh) + ' kWh DC.';
        el('status').textContent = '';
        el('options').hidden = false;
      });
    };
    const invalidate = () => {
      version++;
      clear();
      el('status').textContent = '';
    };
    el('minutes').oninput = el('efficiency').oninput = invalidate;
    el('run').onclick = () => {
      if (!session) return;
      const minutes = el('minutes'),
        efficiency = el('efficiency');
      if (
        !minutes.value ||
        !efficiency.value ||
        !minutes.checkValidity() ||
        !efficiency.checkValidity()
      ) {
        version++;
        clear();
        el('status').textContent = reasons['invalid-evdc-request'];
        return;
      }
      send(
        {
          sessionStart: session.start,
          sessionEnd: session.end,
          minutesEarlier: Number(minutes.value),
          efficiency: Number(efficiency.value) / 100,
        },
        (r) => {
          if (r?.status !== 'indicative') throw Error('Invalid comparison');
          const { baseline: a, scenario: b } = r;
          el('status').textContent =
            'Historisk jämförelse med ' + fmt(r.shifted.energyKWh) + ' kWh DC.';
          paragraph(
            'Alternativ ' +
              time(r.shifted.start) +
              '–' +
              time(r.shifted.end) +
              '. Oförändrad sluttid ' +
              time(r.deadline) +
              '.',
          );
          paragraph('Jämförda klocktimmar ' + time(r.from) + '–' + time(r.to) + '.');
          const metric = (label, before, after, unit) =>
            paragraph(
              label +
                ' ' +
                fmt(before) +
                ' → ' +
                fmt(after) +
                ' ' +
                unit +
                ' (' +
                delta(after - before) +
                ' ' +
                unit +
                ').',
            );
          metric('Nätimport', a.importKWh, b.importKWh, 'kWh');
          metric('Nätexport', a.exportKWh, b.exportKWh, 'kWh');
          metric('Högsta timmedel för nätimport', a.peak.kw, b.peak.kw, 'kW');
          paragraph(
            'Högsta timmen började ' +
              time(a.peak.t) +
              ' enligt mätningen och ' +
              time(b.peak.t) +
              ' i alternativet.',
          );
          if (a.tariffPeak && b.tariffPeak)
            metric(
              'Högsta timmedel inom effekttariffens tider',
              a.tariffPeak.kw,
              b.tariffPeak.kw,
              'kW',
            );
          else paragraph('Ingen tariffgrundande timtopp kan visas för det valda tidsfönstret.');
          if (r.limits.limitKW !== null) {
            paragraph(
              'Kvartar över ' +
                fmt(r.limits.limitKW) +
                ' kW: ' +
                a.importLimit.quarters +
                ' uppmätta → ' +
                b.importLimit.quarters +
                ' i alternativet.',
            );
            if (b.importLimit.peak)
              paragraph(
                'Alternativet överskrider gränsen. Högsta kvartmedel över gränsen är ' +
                  fmt(b.importLimit.peak.kw) +
                  ' kW kl. ' +
                  time(b.importLimit.peak.t) +
                  '.',
              );
            if (r.limits.nominalFuseKW !== null)
              paragraph(
                'Trefasvärde från huvudsäkringen ' +
                  fmt(r.limits.nominalFuseKW) +
                  ' kW vid balanserad last, 400 V och effektfaktor 1.',
              );
            paragraph(
              'Importgränsen kontrolleras mot hela hushållets kvartmedel. Momentana toppar och belastning per fas bedöms inte.',
            );
          }
          if (r.priceGaps.length) {
            const labels = {
              contractQuarters: 'daterade villkor',
              purchasePriceQuarters: 'köppris',
              productionPriceQuarters: 'säljpris',
              'tibber-home-not-confirmed': 'bekräftad mätpunkt',
              'tibber-source-unavailable': 'Tibberkälla',
              'historical-prices-unavailable': 'historiska priser',
              'dated-contract-required': 'daterade villkor',
              'invalid-contract-timeline': 'daterade villkor',
            };
            paragraph(
              'Energikostnad saknas. Kontrollera ' +
                [...new Set(r.priceGaps.map((key) => labels[key] || 'prisunderlag'))].join(', ') +
                '.',
            );
          } else metric('Uppskattad rörlig energikostnad', a.energyCostSek, b.energyCostSek, 'kr');
          paragraph(
            'Energikostnaden använder historiska timpriser. Månadsavgiften för effekt, fasta avgifter och batterislitage ingår inte.',
          );
          if (r.estimatedGridQuarters || r.mixedDirectionQuarters)
            paragraph(
              'Nätunderlag: ' +
                r.estimatedGridQuarters +
                ' kvart med räknarestimat och ' +
                r.mixedDirectionQuarters +
                ' flyttade kvart där både import och export hade uppmätts.',
            );
        },
      );
    };
    return invalidate;
  }
  root.EvdcSessionReplay = { bind };
})(globalThis);
