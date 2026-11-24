(function (root) {
  'use strict';
  const fmt = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 });
  const clock = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const Q = 900000;
  function chart(container, start, series) {
    const expanded = container.querySelector('details')?.open ?? false;
    container.replaceChildren();
    const max = Math.max(1, ...series.flatMap((s) => s.values.filter(Number.isFinite)));
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 480 125');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', series.map((s) => s.name).join(' och ') + ', kvartseffekt i kW');
    function node(tag, attrs) {
      const el = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.append(el);
      return el;
    }
    for (const y of [10, 100]) {
      node('line', { x1: 36, x2: 476, y1: y, y2: y, stroke: 'currentColor', opacity: '.25' });
      node('text', { x: 0, y: y + 4, fill: 'currentColor', 'font-size': 10 }).textContent =
        fmt.format(y === 10 ? max : 0);
    }
    for (const s of series) {
      let path = '',
        previous = false;
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) {
          previous = false;
          return;
        }
        const x = 36 + (i * 440) / 96,
          y = 100 - (v / max) * 90;
        path += (previous ? 'L' : 'M') + x + ' ' + y + 'h' + 440 / 96;
        previous = true;
      });
      node('path', {
        d: path,
        fill: 'none',
        stroke: s.color,
        'stroke-width': 2,
        'stroke-dasharray': s.dash || 'none',
      });
    }
    for (const i of [0, 24, 48, 72, 96]) {
      node('text', {
        x: 36 + (i * 440) / 96,
        y: 118,
        fill: 'currentColor',
        'font-size': 10,
        'text-anchor': i === 96 ? 'end' : i === 0 ? 'start' : 'middle',
      }).textContent = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Stockholm',
        hour: '2-digit',
        minute: '2-digit',
      }).format(start + i * Q);
    }
    const caption = document.createElement('p');
    caption.textContent =
      series.map((s) => s.name).join(' · ') +
      ' · kW · ' +
      clock.format(start) +
      ' – ' +
      clock.format(start + 96 * Q);
    container.append(svg, caption);
    const details = document.createElement('details'),
      summary = document.createElement('summary');
    summary.textContent = 'Visa kvartsvärden';
    details.append(summary);
    const table = document.createElement('table');
    for (let i = -1; i < 96; i++) {
      const row = table.insertRow();
      for (const text of i === -1
        ? ['Kvart', ...series.map((s) => s.name + ' (kW)')]
        : [
            clock.format(start + i * Q),
            ...series.map((s) => (Number.isFinite(s.values[i]) ? fmt.format(s.values[i]) : '–')),
          ]) {
        const cell = document.createElement(i === -1 ? 'th' : 'td');
        cell.textContent = text;
        row.append(cell);
      }
    }
    details.open = expanded;
    details.append(table);
    container.append(details);
  }
  function bind(Homey) {
    const el = (id) => document.getElementById('forecast-' + id);
    let request = 0;
    function load() {
      const generation = ++request;
      function unavailable() {
        for (const id of ['range', 'peak', 'total', 'comparison', 'accuracy', 'chart'])
          el(id).replaceChildren();
        el('status').textContent = 'Prognosen kunde inte hämtas.';
      }
      const timeout = setTimeout(() => {
        if (generation === request) {
          request++;
          unavailable();
        }
      }, 15000);
      Homey.api('GET', '/forecast/household', null, (error, r) => {
        clearTimeout(timeout);
        if (generation !== request) return;
        if (error || !Array.isArray(r?.forecastKW) || r.forecastKW.length !== 96) {
          unavailable();
          return;
        }
        el('status').textContent =
          (r.known === 0
            ? 'Samlar hushållsmätningar. '
            : r.comparable < 96
              ? 'Begränsat underlag. '
              : '') +
          r.known +
          ' av 96 kvartar har prognos. ' +
          r.comparable +
          ' bygger på minst tre jämförbara dagar. Övriga använder i första hand gårdagens kvart och i andra hand tidigare mätningar vid samma klockslag, uppdelade på vardag och helg.';
        el('total').textContent = r.totalKWh === null ? '–' : fmt.format(r.totalKWh) + ' kWh';
        el('peak').textContent =
          r.peakKW === null
            ? '–'
            : fmt.format(r.peakKW) +
              ' kW · ' +
              clock.format(r.peakAt) +
              (r.known < 96 ? ' (täckta kvartar)' : '');
        el('range').textContent = r.rangeKWh
          ? 'Erfarenhetsbaserat dygnsintervall (10:e–90:e percentilen) ' +
            r.rangeKWh.map((v) => fmt.format(v)).join('–') +
            ' kWh.'
          : 'Dygnsintervallet visas efter 14 helt utvärderade dygn med komplett aktuell prognos.';
        const predicted = (values) => ({
          name: 'Prognos (streckad)',
          values,
          color: '#367fb4',
          dash: '5 2',
        });
        chart(el('chart'), r.start, [predicted(r.forecastKW)]);
        if (r.comparison)
          chart(el('comparison'), r.comparison.start, [
            predicted(r.comparison.forecastKW),
            { name: 'Uppmätt (heldragen)', values: r.comparison.actualKW, color: '#b56a28' },
          ]);
        else
          el('comparison').textContent =
            'Första jämförelsen visas efter ett uppmätt prognosintervall.';
        const s = r.score;
        const lastErrorKWh = r.recentErrorKWh ?? s.lastErrorKWh;
        const summary = el('accuracy');
        summary.replaceChildren();
        const paragraph = (text) => {
          const p = document.createElement('p');
          p.textContent = text;
          summary.append(p);
        };
        paragraph(
          'Avslutade rullande 24-timmarsprognoser: ' +
            r.completedRuns +
            '. Helt utvärderade: ' +
            r.fullyScoredRuns +
            '.',
        );
        if (r.completedRuns && r.comparison) {
          const { forecastKW, actualKW } = r.comparison;
          const paired = forecastKW.filter(
            (v, i) => Number.isFinite(v) && Number.isFinite(actualKW[i]),
          ).length;
          paragraph(
            'I perioden som visas ovan har ' +
              paired +
              ' av 96 kvartar både prognos och mätvärde. Kvartar utan prognos: ' +
              forecastKW.filter((v) => !Number.isFinite(v)).length +
              '. Kvartar utan komplett mätning: ' +
              actualKW.filter((v) => !Number.isFinite(v)).length +
              '.',
          );
        }
        paragraph(
          Number.isFinite(lastErrorKWh)
            ? 'Senaste kompletta dygnets utfall minus prognos: ' +
                fmt.format(lastErrorKWh) +
                ' kWh.'
            : 'Dygnsfelet kan beräknas när alla 96 kvartar har både prognos och komplett mätning.',
        );
        if (s.pairs)
          paragraph(
            'Medelabsolutfel i dygnsreferenserna (' +
              s.pairs +
              ' jämförbara kvartar): prognos ' +
              fmt.format(s.maeKW) +
              ' kW, gårdagens profil ' +
              fmt.format(s.yesterdayMaeKW) +
              ' kW.',
          );
      });
    }
    load();
    setInterval(() => {
      if (!document.getElementById('panel-forecast').hidden) load();
    }, 60000);
    document.getElementById('tab-forecast').addEventListener('click', load);
  }
  root.HouseholdForecastView = { bind };
})(globalThis);
