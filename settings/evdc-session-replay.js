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
    'evdc-import-limit-required':
      'Spara en importgräns eller trefas huvudsäkring under Hushåll först.',
    'evdc-phase-meter-required':
      'Huvudsäkringen kräver fasström vid nätanslutningen. Välj Sigenergy Gateway eller SDM630 i enhetens avancerade inställningar.',
    'evdc-phase-coverage-required':
      'Huvudsäkringen kan bedömas när nätmätaren har sparat hela kvartar för alla tre faser.',
    'evdc-phase-over-limit': 'Uppmätt eller beräknad fasström överskrider huvudsäkringens gräns.',
    'evdc-prices-required': 'En billigaste profil kräver komplett pris- och tariffunderlag.',
    'evdc-original-in-tariff':
      'Det uppmätta passet överlappar tariffens effekttimmar. Det här läget jämför pass som ryms utanför dem.',
    'evdc-household-over-limit': 'Hushållets övriga import överskrider gränsen i perioden.',
    'evdc-tail-over-limit': 'Sista laddkvartens uppmätta energi ryms inte under gränsen.',
    'evdc-insufficient-headroom':
      'Laddenergin ryms inte under gränsen före sluttiden. Prova en längre sökperiod.',
    'evdc-inverted-prices':
      'Säljpriset är högre än köppriset i en kvart med export. Sökningen kan inte jämföra den säkert.',
    'invalid-household-import-limits': 'Kontrollera importgränserna under Inställningar → Hushåll.',
  };
  const priceLabels = {
    contractQuarters: 'daterade villkor',
    purchasePriceQuarters: 'köppris',
    productionPriceQuarters: 'säljpris',
    'tibber-home-not-confirmed': 'bekräftad mätpunkt',
    'tibber-source-unavailable': 'Tibberkälla',
    'historical-prices-unavailable': 'historiska priser',
    'dated-contract-required': 'daterade villkor',
    'invalid-contract-timeline': 'daterade villkor',
  };
  const priceDetails = (gaps) =>
    [...new Set(gaps.map((key) => priceLabels[key] || 'prisunderlag'))].join(', ');
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
            ['phaseMissing', 'Saknad eller ofullständig strömmätning vid nätanslutningen'],
          ]) {
            if (result[key]?.length)
              paragraph(
                label + ' i ' + result[key].length + ' kvart, från ' + time(result[key][0]) + '.',
              );
          }
          if (result.priceGaps?.length)
            paragraph('Kontrollera ' + priceDetails(result.priceGaps) + '.');
          if (Number.isFinite(result.missingKWh))
            paragraph('Energi som inte ryms: ' + fmt(result.missingKWh) + ' kWh.');
          if (result.phase && Number.isFinite(result.amps))
            paragraph(result.phase + ' hade en uppmätt topp på ' + fmt(result.amps) + ' A.');
          if (Number.isFinite(result.at)) paragraph('Berörd kvart börjar ' + time(result.at) + '.');
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
    function run(optimise) {
      if (!session) return;
      const minutes = el('minutes'),
        efficiency = el('efficiency');
      if (
        !minutes.value ||
        !efficiency.value ||
        !minutes.checkValidity() ||
        !efficiency.checkValidity() ||
        (!optimise && Number(minutes.value) === 0)
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
          ...(optimise ? { optimise: true } : {}),
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
            paragraph('Importgränsen kontrolleras mot hela hushållets kvartmedel.');
          }
          if (r.phaseLimit) {
            const { fuseA, measuredPeakA, modelledPeakA, voltageFloor, powerFactorFloor } =
              r.phaseLimit;
            paragraph('Fasgräns ' + fuseA + ' A. Uppmätt topp → beräknad topp per fas.');
            measuredPeakA.forEach((amps, i) => metric('L' + (i + 1), amps, modelledPeakA[i], 'A'));
            paragraph(
              'Modellen lägger hela laddökningen på en fas åt gången och räknar med minst ' +
                voltageFloor +
                ' V och effektfaktor ' +
                fmt(powerFactorFloor) +
                '. Toppar mellan mätningar kan saknas.',
            );
          } else paragraph('Denna beräkning använder enbart total nätimport.');
          if (r.priceGaps.length) {
            paragraph('Energikostnad saknas. Kontrollera ' + priceDetails(r.priceGaps) + '.');
          } else metric('Uppskattad rörlig energikostnad', a.energyCostSek, b.energyCostSek, 'kr');
          if (r.planQuarters) {
            paragraph(
              'Ändring av effektavgift ' +
                fmt(r.demandCostDifferenceSek) +
                ' kr. Samma import ligger inom effekttariffens tider.',
            );
            paragraph(
              'Total kostnadsskillnad (energi och effekt): ' +
                delta(r.totalCostDifferenceSek) +
                ' kr. Fasta avgifter är lika i båda alternativen.',
            );
            const details = document.createElement('details');
            details.className = 'settings-details';
            const summary = document.createElement('summary');
            summary.textContent = 'Visa den billigaste laddprofilen';
            details.appendChild(summary);
            const quarters = document.createElement('ul');
            for (const row of r.planQuarters) {
              const li = document.createElement('li');
              li.textContent =
                time(row.t) +
                ' · DC ' +
                fmt(row.chargeKW) +
                ' kW · total nätimport ' +
                fmt(row.importKW) +
                ' kW';
              quarters.appendChild(li);
            }
            details.appendChild(quarters);
            el('results').appendChild(details);
          } else
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
    }
    el('run').onclick = () => run(false);
    el('optimise').onclick = () => run(true);
    return invalidate;
  }
  root.EvdcSessionReplay = { bind };
})(globalThis);
