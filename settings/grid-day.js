'use strict';

globalThis.GridDayView = (() => {
  const units = { amps: 'A', volts: 'V', activeKW: 'kW', reactiveKvar: 'kvar' };
  const lines = [
    { key: 'min', title: 'Min', color: '#007a71', dash: '3 3' },
    { key: 'mean', title: 'Medel', color: '#4267bf', dash: '' },
    { key: 'max', title: 'Max', color: '#bc6929', dash: '9 3' },
  ];
  const number = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 3 });
  const time = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
  });
  const svgNode = (tag, attrs, label) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    if (label !== undefined) el.textContent = label;
    return el;
  };
  function chart({ start, end, binMs, bins, events = [] }, unit) {
    const svg = svgNode('svg', {
      viewBox: '0 0 400 190',
      width: '100%',
      role: 'img',
      'aria-label': 'Minsta, genomsnittliga och högsta uppmätta värde per fem minuter i ' + unit,
    });
    const low = Math.min(...bins.map((b) => b.min)),
      high = Math.max(...bins.map((b) => b.max));
    const pad = high === low ? 0.05 : (high - low) * 0.07;
    const x = (b) =>
      52 + (336 * (Math.max(start, Math.min(end, b.t + binMs / 2)) - start)) / (end - start);
    const y = (v) => 138 - (118 * (v - low + pad)) / (high - low + 2 * pad);
    const label = (x, y, value, anchor = 'start', color = 'currentColor') =>
      svgNode('text', { x, y, 'text-anchor': anchor, fill: color, 'font-size': 12 }, value);
    for (const tick of new Set([low, (low + high) / 2, high])) {
      svg.append(
        svgNode('line', {
          x1: 52,
          x2: 388,
          y1: y(tick),
          y2: y(tick),
          stroke: 'currentColor',
          opacity: 0.18,
        }),
        label(48, y(tick) + 4, number.format(tick), 'end'),
      );
    }
    let previousMode;
    for (const event of events) {
      if (!event.resumed && previousMode === 0 && (event.mode === 1 || event.mode === 2)) {
        const xAt = 52 + (336 * (event.at - start)) / (end - start);
        const marker = svgNode('line', {
          x1: xAt,
          x2: xAt,
          y1: 18,
          y2: 138,
          stroke: 'currentColor',
          'stroke-dasharray': '2 4',
        });
        marker.append(svgNode('title', {}, 'Ödrift observerad ' + time.format(event.at)));
        svg.append(marker);
      }
      previousMode = event.mode;
    }
    for (const [i, line] of lines.entries()) {
      let path = '';
      for (const [j, b] of bins.entries()) {
        const connected = j > 0 && b.t - bins[j - 1].t === binMs;
        path += (connected ? ' L' : ' M') + x(b) + ' ' + y(b[line.key]);
        if (!connected && bins[j + 1]?.t !== b.t + binMs)
          svg.append(svgNode('circle', { cx: x(b), cy: y(b[line.key]), r: 2, fill: line.color }));
      }
      svg.append(
        svgNode('path', {
          d: path,
          stroke: line.color,
          'stroke-width': 1.8,
          'stroke-dasharray': line.dash,
          fill: 'none',
        }),
      );
      const left = 68 + i * 108;
      svg.append(
        svgNode('line', {
          x1: left,
          x2: left + 18,
          y1: 180,
          y2: 180,
          stroke: line.color,
          'stroke-width': 2,
          'stroke-dasharray': line.dash,
        }),
        label(left + 23, 184, line.title),
      );
    }
    for (const [fraction, anchor] of [
      [0, 'start'],
      [0.5, 'middle'],
      [1, 'end'],
    ])
      svg.append(
        label(52 + 336 * fraction, 160, time.format(start + (end - start) * fraction), anchor),
      );
    return svg;
  }
  function table(bins) {
    const el = document.createElement('table');
    const header = el.createTHead().insertRow();
    for (const title of ['Tid', 'Min', 'Medel', 'Max', 'Antal']) {
      const th = document.createElement('th');
      th.textContent = title;
      header.append(th);
    }
    const body = el.createTBody();
    for (const b of [...bins].reverse()) {
      const tr = body.insertRow();
      for (const value of [
        time.format(b.t),
        number.format(b.min),
        number.format(b.mean),
        number.format(b.max),
        b.count,
      ])
        tr.insertCell().textContent = value;
    }
    return el;
  }
  function bind(Homey) {
    if (typeof Homey.api !== 'function') return;
    const get = (id) => document.getElementById('gridDay' + id);
    const details = get('Details'),
      metric = get('Metric'),
      phase = get('Phase');
    let revision = 0;
    function refresh() {
      const request = ++revision;
      if (!details.open || details.closest('[hidden]')) return;
      Homey.api(
        'POST',
        '/diagnostics/grid-day',
        { metric: metric.value, phase: Number(phase.value) },
        (err, result) => {
          if (request !== revision) return;
          const target = get('Chart'),
            values = get('Table');
          target.replaceChildren();
          values.replaceChildren();
          get('Source').textContent =
            err || !result
              ? ''
              : result.profile === 'gateway'
                ? 'Mätkälla: Sigenergy Gateway, nätsidan.'
                : result.profile === 'sdm630'
                  ? 'Mätkälla: SDM630 vid nätanslutningen (ström).'
                  : 'Ingen aktiv mätkälla.';
          const events = result?.events ?? [];
          const list = document.getElementById('gridEvents');
          list.replaceChildren();
          document.getElementById('gridEventDetails').hidden =
            !!err || result?.profile !== 'gateway';
          for (const event of events.slice(-30).reverse()) {
            const row = document.createElement('li');
            const mode =
              ['Nätdrift', 'Automatisk ödrift', 'Manuell ödrift'][event.mode] ?? 'Okänt driftläge';
            const names = [
              'Nätavbrott',
              'Överspänning',
              'Underspänning',
              'Överfrekvens',
              'Underfrekvens',
              'Spänningsobalans',
            ];
            const alarms = !Number.isInteger(event.alarms)
              ? 'Larmstatus saknas'
              : names.filter((_, i) => event.alarms & (1 << i)).join(', ') || 'Inga aktiva nätlarm';
            const timestamp = new Date(event.at).toLocaleTimeString('sv-SE', {
              timeZone: 'Europe/Stockholm',
            });
            row.textContent =
              timestamp +
              ' · ' +
              mode +
              ' · ' +
              alarms +
              (event.resumed ? ' (första avläsning i mätperioden)' : '');
            list.append(row);
          }
          if (!events.length) list.textContent = 'Inga observationer under de senaste 24 timmarna.';
          const bins = result?.bins;
          if (err || !Array.isArray(bins) || !bins.length) {
            get('Status').textContent = err
              ? 'Kunde inte hämta dygnshistoriken.'
              : metric.value === 'volts' && result?.profile === 'gateway'
                ? 'Ingen giltig fasspänning för L' +
                  (Number(phase.value) + 1) +
                  ' från gatewayens nätsida de senaste 24 timmarna. ' +
                  (result.phaseCurrentSamples
                    ? 'Under samma period finns ' +
                      number.format(result.phaseCurrentSamples) +
                      ' strömmätningar för fasen. Gatewayens Modbus-register för spänning varierar mellan protokollversioner.'
                    : 'Det saknas även strömmätningar för fasen under perioden.')
                : 'Inga avläsningar för den valda serien under de senaste 24 timmarna.';
            return;
          }
          get('Status').textContent =
            bins.reduce((n, b) => n + b.count, 0) + ' avläsningar · ' + units[metric.value];
          target.append(chart(result, units[metric.value]));
          values.append(table(bins));
        },
      );
    }
    details.addEventListener('toggle', refresh);
    metric.addEventListener('change', refresh);
    phase.addEventListener('change', refresh);
    setInterval(refresh, 30000);
  }
  return { bind };
})();
