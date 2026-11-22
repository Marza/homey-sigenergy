'use strict';
const Q = 900000,
  M = 300000;
const fmt = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 });
const clock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});
const time = (t) => clock.format(t);
const value = (x, unit) => (Number.isFinite(x) ? fmt.format(x) + ' ' + unit : '–');
const by = (id) => document.getElementById(id);
const actions = {
  buy: 'Nätladda',
  sell: 'Sälj från batteriet',
  hold: 'Behåll laddnivån',
  solar: 'Lagra solel',
  house: 'Använd i huset',
};
const reasons = {
  prices: 'Fler publicerade priser behövs.',
  load: 'Komplett last- och solunderlag saknas för nästa kvart i planen.',
  grid: 'Planen pausas tills stabil nätdrift är bekräftad.',
  contract: 'Publicera daterade kostnadsvillkor för perioden.',
  limit: 'Ange hushållets importgräns.',
  battery: 'Kontrollera batteriets aktuella gränser och om en plan ryms inom importgränsen.',
};
function draw(data, day, index) {
  const { start, end } = data.days[day],
    rows = data.quarters.filter((r) => r.t >= start && r.t < end);
  const measured = data.measured.filter((r) => r.t >= start && r.t < end);
  const plan = data.plan.filter((r) => r.t >= start && r.t < end);
  const svg = by('chart');
  svg.replaceChildren();
  const add = (name, attrs, text) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    svg.append(el);
  };
  const prices = rows.flatMap((r) => [r.buy, r.sell]).filter(Number.isFinite);
  const lo = Math.floor(Math.min(0, ...prices) * 2) / 2,
    hi = Math.max(lo + 0.5, Math.ceil(Math.max(0, ...prices) * 2) / 2);
  const x = (t) => 37 + ((t - start) / (end - start)) * 326,
    py = (p) => 185 - (175 * (p - lo)) / (hi - lo),
    sy = (s) => 185 - (175 * s) / 100;
  for (let i = 0; i <= 4; i++) {
    const y = sy(i * 25);
    add('line', {
      x1: 37,
      x2: 363,
      y1: y,
      y2: y,
      stroke: 'var(--line)',
      'stroke-dasharray': '3 4',
    });
    add(
      'text',
      { x: 32, y: y + 4, 'text-anchor': 'end' },
      prices.length ? fmt.format(lo + (i * (hi - lo)) / 4) : '',
    );
    add('text', { x: 368, y: y + 4 }, String(i * 25));
  }
  for (let t = start; t < end; t += 3600000) {
    const label = time(t);
    if (Number(label.slice(0, 2)) % 4 === 0)
      add('text', { x: x(t), y: 206, 'text-anchor': 'middle' }, label);
  }
  const line = (points, color, dashed = false) => {
    let d = '',
      last = null;
    for (const p of points) {
      if (!Number.isFinite(p.y)) {
        last = null;
        continue;
      }
      d += (last === null || p.t - last > p.gap ? 'M' : 'L') + x(p.t) + ' ' + p.y + ' ';
      last = p.t;
    }
    if (d)
      add('path', {
        d,
        stroke: color,
        'stroke-width': 2.3,
        ...(dashed ? { 'stroke-dasharray': '5 5' } : {}),
      });
  };
  for (const [key, color] of [
    ['buy', 'var(--buy)'],
    ['sell', 'var(--sell)'],
  ]) {
    line(
      rows.flatMap((r) =>
        [r.t, r.t + Q].map((t) => ({ t, y: Number.isFinite(r[key]) ? py(r[key]) : null, gap: Q })),
      ),
      color,
    );
  }
  const actual = measured.map((r) => ({ t: r.t, y: sy(r.soc), gap: M }));
  if (data.now >= start && data.now < end && Number.isFinite(data.liveSoc))
    actual.push({ t: data.now, y: sy(data.liveSoc), gap: M });
  line(actual, 'var(--soc)');
  if (actual.length) {
    const last = actual.at(-1);
    add('circle', { cx: x(last.t), cy: last.y, r: 3, fill: 'var(--soc)' });
  }
  line(
    plan.flatMap((r) => [
      { t: r.t, y: sy(r.soc), gap: Q },
      { t: r.t + Q, y: sy(r.endSoc), gap: Q },
    ]),
    'var(--soc)',
    true,
  );
  const row = rows[index];
  if (!row) return;
  add('line', { x1: x(row.t), x2: x(row.t), y1: 10, y2: 185, stroke: 'var(--sub)', opacity: 0.45 });
  const p = plan.find((p) => p.t === row.t),
    m = measured.filter((p) => p.t >= row.t && p.t < row.t + Q).at(-1);
  by('time').textContent = time(row.t) + '–' + time(row.t + Q);
  by('detail').textContent =
    'Köp ' +
    value(row.buy, 'kr/kWh') +
    ' · Sälj ' +
    value(row.sell, 'kr/kWh') +
    ' · ' +
    (p
      ? 'Prognos ' + value(p.soc, '%') + ' → ' + value(p.endSoc, '%') + ' · ' + actions[p.action]
      : 'Uppmätt ' + value(m?.soc, '%'));
  const windows = [];
  for (const p of plan.filter((p) => p.action === 'buy' || p.action === 'sell')) {
    const kWh = p.action === 'buy' ? p.buyKWh : p.sellKWh,
      last = windows.at(-1);
    if (last?.action === p.action && last.end === p.t) {
      last.end += Q;
      last.kWh += kWh;
    } else windows.push({ start: p.t, end: p.t + Q, action: p.action, kWh });
  }
  by('actions').replaceChildren();
  for (const w of windows) {
    const div = document.createElement('div'),
      b = document.createElement('b'),
      span = document.createElement('span');
    div.className = 'window';
    b.textContent = time(w.start) + '–' + time(w.end);
    span.textContent = actions[w.action] + ' · ' + value(w.kWh, 'kWh');
    div.append(b, span);
    by('actions').append(div);
  }
  if (!windows.length)
    by('actions').textContent = plan.length
      ? 'Inga planerade batteriaffärer under perioden.'
      : 'Ingen plan för perioden.';
  by('status').textContent =
    (plan.length ? 'Plan till ' + time(plan.at(-1).t + Q) + '. ' : '') +
    (reasons[data.reason] ?? '') +
    (data.missingPhase ? ' Saknad fashistorik begränsar batteriaffärer under vissa kvartar.' : '');
}
window.onHomeyReady = function (Homey) {
  let data,
    day = 'today',
    index = 0,
    request = 0;
  const layout = window.WidgetLayout.create(Homey, { document, view: window });
  function render(reset) {
    if (!data) return;
    const { start, end } = data.days[day],
      max = (end - start) / Q - 1;
    if (reset) index = Math.max(0, Math.min(max, Math.floor((data.now - start) / Q)));
    by('cursor').max = max;
    by('cursor').value = index;
    draw(data, day, index);
    layout.refresh();
  }
  async function load() {
    const id = ++request;
    try {
      const next = await Homey.api('GET', '/');
      if (request !== id) return;
      const reset = !data || next.days.today.start !== data.days.today.start;
      data = next;
      render(reset);
    } catch {
      if (request !== id) return;
      data = null;
      for (const name of ['chart', 'detail', 'actions', 'time']) by(name).replaceChildren();
      by('status').textContent = 'Kunde inte läsa prognosunderlaget.';
      layout.refresh();
    }
  }
  by('day').onchange = (e) => {
    day = e.target.value;
    render(true);
  };
  by('cursor').oninput = (e) => {
    index = Number(e.target.value);
    render(false);
  };
  by('widget-content').addEventListener('toggle', () => layout.refresh(), true);
  layout.refresh();
  load();
  const timer = setInterval(() => {
    if (!document.hidden) load();
  }, 60000);
  window.addEventListener('pagehide', (e) => {
    if (!e.persisted) {
      request++;
      clearInterval(timer);
      layout.dispose();
    }
  });
};
