(function (root) {
  'use strict';

  const QUARTER = 900000;
  const labels = {
    grid: 'Nät',
    solar: 'Sol',
    battery: 'Batteri',
    dc: 'DC-laddare',
    ac: 'AC-laddare',
    house: 'Hus',
  };
  const number = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 });
  const time = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
  });
  const timeWithOffset = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
  });
  const value = (n) => (Number.isFinite(n) ? number.format(n) : '–');
  const colors = (element) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(
      [...Object.keys(labels), 'muted', 'line', 'ink'].map((key) => [
        key,
        style.getPropertyValue('--' + key).trim(),
      ]),
    );
  };

  function canvasPainter(canvas, paint) {
    let frame;
    function redraw() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { width, height } = canvas.getBoundingClientRect();
        if (width === 0 || height === 0) return;
        const scale = Math.min(devicePixelRatio || 1, 2);
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        paint(ctx, width, height, colors(canvas));
      });
    }
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', redraw);
    root.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      cancelAnimationFrame(frame);
      observer.disconnect();
      scheme.removeEventListener('change', redraw);
    });
    return redraw;
  }

  function mount(Homey, render) {
    const date = document.getElementById('history-date');
    const period = document.getElementById('history-period');
    const back = document.getElementById('history-back');
    const next = document.getElementById('history-next');
    const status = document.getElementById('history-status');
    const results = document.getElementById('history-results');
    const layout = root.WidgetLayout.create(Homey, { document, view: root });
    let selected = 'today';
    let range;
    let request = 0;

    function move(nextDate) {
      if (!nextDate) return;
      selected = nextDate === range?.today ? 'today' : nextDate;
      load(true);
    }
    back.onclick = () => move(range?.previous);
    next.onclick = () => move(range?.next);
    date.onchange = () => {
      if (date.checkValidity()) move(date.value);
    };
    if (period) period.onchange = () => load(true);

    function load(initial) {
      const id = ++request;
      if (initial) {
        results.hidden = true;
        back.disabled = next.disabled = true;
        status.textContent = 'Hämtar historik…';
      }
      const fail = () => {
        if (id !== request) return;
        request++;
        results.hidden = true;
        status.textContent = 'Historiken kunde inte hämtas.';
        layout.refresh();
      };
      const timeout = setTimeout(fail, 10000);
      const path = '/' + encodeURIComponent(selected) + (period ? '/' + period.value : '');
      Promise.resolve()
        .then(() => Homey.api('GET', path))
        .then((report) => {
          if (id !== request) return;
          if (
            report?.schema !== 1 ||
            !report.range ||
            !['ok', 'unavailable'].includes(report.status)
          )
            throw Error('Invalid history');
          range = report.range;
          date.value = range.date;
          date.min = range.earliest;
          date.max = range.latest ?? range.today;
          back.disabled = !range.previous;
          next.disabled = !range.next;
          if (report.status !== 'ok') return fail();
          const hasData = render(report);
          results.hidden = !hasData;
          status.textContent = hasData
            ? ''
            : range.date > range.today
              ? 'Ingen hushållsprognos för dygnet.'
              : 'Inga kompletta mätintervall för perioden.';
          layout.refresh();
        })
        .catch(fail)
        .finally(() => clearTimeout(timeout));
    }

    layout.refresh();
    load(true);
    const timer = setInterval(() => {
      if (!document.hidden && (!range || selected === 'today' || range.elapsedEnd < range.end))
        load(false);
    }, 60000);
    root.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      request++;
      clearInterval(timer);
      layout.dispose();
    });
  }

  root.HistoryWidget = { QUARTER, labels, value, time, timeWithOffset, mount, canvasPainter };
})(globalThis);
