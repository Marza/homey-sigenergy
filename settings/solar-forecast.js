(function (root) {
  'use strict';
  const fmt = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 });
  const clock = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
  });
  const sum = (values) => values.reduce((total, n) => total + n, 0);
  function bind(Homey) {
    const el = (id) => document.getElementById('solar-' + id);
    let initialized = false,
      generation = 0;
    const fields = el('fields'),
      list = el('roofs'),
      enabled = el('enabled'),
      select = el('issued');
    function addRoof(roof = {}) {
      const group = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = 'Takyta';
      group.append(legend);
      for (const [key, title, min, max] of [
        ['name', 'Namn'],
        ['kwp', 'Paneleffekt (kWp)', 0.001, 1000],
        ['tilt', 'Lutning från horisontalplanet (°)', 0, 90],
        ['bearing', 'Kompassriktning (°)', 0, 360],
      ]) {
        const label = document.createElement('label'),
          input = document.createElement('input');
        label.textContent = title;
        input.name = key;
        input.className = 'hy-nostyle';
        input.required = true;
        if (key === 'name') input.maxLength = 40;
        else {
          input.type = 'number';
          input.min = min;
          input.max = max;
          input.step = 'any';
        }
        input.value = roof[key] ?? '';
        label.append(input);
        group.append(label);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'hy-nostyle';
      remove.textContent = 'Ta bort takyta';
      remove.onclick = () => {
        group.remove();
        syncButtons();
      };
      group.append(remove);
      list.append(group);
      syncButtons();
    }
    function syncButtons() {
      el('add').disabled = list.children.length >= 4;
      for (const b of list.querySelectorAll('button')) b.disabled = list.children.length === 1;
    }
    function init(config) {
      enabled.checked = config?.enabled ?? false;
      el('lat').value = config?.latitude ?? '';
      el('lon').value = config?.longitude ?? '';
      el('loss').value = config?.loss ?? 14;
      for (const roof of config?.roofs ?? [{}]) addRoof(roof);
      fields.disabled = !enabled.checked;
      el('save').disabled = false;
      initialized = true;
    }
    let lastReport;
    const revisionSelect = el('revision');
    revisionSelect.onchange = () => render(lastReport);
    function renderAccuracy(accuracy) {
      el('accuracy').hidden = !accuracy;
      if (!accuracy) return;
      const { daylight, adjusted, paired } = accuracy;
      el('coverage').textContent = daylight
        ? 'Av ' +
          daylight +
          ' avslutade dagsljuskvartar hade ' +
          adjusted +
          ' en justering. Kvartar med både justering och full mätning: ' +
          paired +
          '.'
        : 'Väntar på den första avslutade dagsljuskvarten med väderprognos.';
      el('metrics').hidden = !paired;
      if (!paired) return;
      for (const key of ['original', 'corrected']) {
        const { maeWh, over } = accuracy[key];
        el(key + '-error').textContent = fmt.format(maeWh) + ' Wh';
        el(key + '-over').textContent =
          fmt.format((100 * over) / paired) + ' % (' + over + '/' + paired + ')';
      }
    }
    function render(r) {
      renderAccuracy(r.accuracy);
      if (lastReport?.issue?.at !== r.issue?.at) revisionSelect.value = '';
      lastReport = r;
      el('status').textContent = {
        off: 'Solprognosen är avstängd.',
        pending: 'Väntar på den första väderprognosen för dina takytor.',
        ok: 'Prognosen uppdateras i bakgrunden.',
        stale: 'Den senaste väderprognosen är äldre än två timmar.',
        'weather-error': 'Väderhämtningen misslyckades. Homey försöker igen om 15 minuter.',
      }[r.status];
      const latest = select.value || '';
      select.replaceChildren(new Option('Senaste prognos', ''));
      for (const at of [...r.issued].reverse())
        select.add(new Option(clock.format(at), String(at)));
      select.value = r.issued.includes(Number(latest)) ? latest : '';
      el('result').hidden = !r.issue && !r.issued.length;
      for (const id of ['range', 'totals', 'comparison']) el(id).replaceChildren();
      if (!r.issue) {
        el('chart').replaceChildren();
        return;
      }
      const { at, start, roofs, actualWh } = r.issue;
      el('range').textContent =
        'Utfärdad ' +
        clock.format(at) +
        ' · ' +
        clock.format(start) +
        ' – ' +
        clock.format(start + 86400000);
      const expected = actualWh.map((_, i) =>
        roofs.every((r) => Number.isFinite(r.wh[i])) ? sum(roofs.map((r) => r.wh[i])) : null,
      );
      for (const roof of [...roofs, { name: 'Totalt', wh: expected }]) {
        const li = document.createElement('li'),
          values = roof.wh.filter(Number.isFinite);
        li.textContent =
          roof.name +
          ' · ' +
          (values.length === 96
            ? fmt.format(sum(values) / 1000) + ' kWh'
            : 'Ofullständig prognos (' + values.length + '/96 kvartar)');
        el('totals').append(li);
      }
      const pairs = expected
        .map((wh, i) => [wh, actualWh[i]])
        .filter((pair) => pair.every(Number.isFinite));
      el('comparison').textContent = pairs.length
        ? 'För ' +
          pairs.length +
          ' jämförbara kvartar: prognos ' +
          fmt.format(sum(pairs.map((p) => p[0])) / 1000) +
          ' kWh, Sigenergy ' +
          fmt.format(sum(pairs.map((p) => p[1])) / 1000) +
          ' kWh.'
        : 'Väntar på avslutade kvartar med komplett solmätning från samma källa.';
      const revisions = r.issue.adjustments ?? [];
      const revision =
        revisions.find((v) => String(v.at) === revisionSelect.value) ?? revisions.at(-1);
      const selection = revisionSelect.value;
      revisionSelect.replaceChildren(new Option('Senaste justering', ''));
      for (const item of [...revisions].reverse())
        revisionSelect.add(new Option(clock.format(item.at), String(item.at)));
      revisionSelect.value = revisions.some((item) => String(item.at) === selection)
        ? selection
        : '';
      el('revision-label').hidden = revisionSelect.hidden = !revisions.length;
      const adjusted = Array(96).fill(null);
      el('score').textContent = '';
      el('adjustment').textContent =
        'Originalprognos från väderunderlaget. En justering kräver minst tre kompletta produktionskvartar den senaste timmen.';
      if (revision?.wh) {
        const offset = (revision.start - start) / 900000;
        revision.wh.forEach((value, i) => {
          adjusted[offset + i] = value;
        });
        const original = expected.slice(offset, offset + revision.wh.length);
        const valid = revision.wh.filter(Number.isFinite);
        el('adjustment').textContent =
          'Justerad ' +
          clock.format(revision.at) +
          ' utifrån ' +
          revision.samples +
          ' kvartar. Från ' +
          clock.format(revision.start) +
          ' till ' +
          clock.format(revision.start + revision.wh.length * 900000) +
          ': original ' +
          fmt.format(sum(original.filter(Number.isFinite)) / 1000) +
          ' kWh, justerat ' +
          fmt.format(sum(valid) / 1000) +
          ' kWh (' +
          valid.length +
          '/' +
          original.length +
          ' kvartar).';
        const indices = adjusted
          .map((v, i) => (Number.isFinite(v) && Number.isFinite(actualWh[i]) ? i : -1))
          .filter((i) => i >= 0);
        const kWh = (values) => fmt.format(sum(indices.map((i) => values[i])) / 1000);
        el('score').textContent = indices.length
          ? 'Utfall efter justeringen, ' +
            indices.length +
            ' gemensamma kvartar: original ' +
            kWh(expected) +
            ' kWh, justerat ' +
            kWh(adjusted) +
            ' kWh, Sigenergy ' +
            kWh(actualWh) +
            ' kWh.'
          : 'Väntar på mätningar för perioden efter justeringen.';
      } else if (revision) {
        el('adjustment').textContent =
          'Åter till originalprognosen ' +
          clock.format(revision.at) +
          '. Tillräckligt aktuellt mätunderlag saknades.';
      }
      const kw = (arr) => arr.map((n) => (Number.isFinite(n) ? n / 250 : null));
      root.HouseholdForecastView.chart(
        el('chart'),
        start,
        [
          { name: 'Originalprognos', values: kw(expected), dash: '5 3', color: '#187d76' },
          ...(revision?.wh
            ? [{ name: 'Justerad prognos', values: kw(adjusted), dash: '2 2', color: '#7859ab' }]
            : []),
          { name: 'Sigenergy', values: kw(actualWh), color: '#ae601c' },
        ],
        { groupZeroForecast: true },
      );
    }
    function load() {
      const seq = ++generation;
      Homey.api(
        'GET',
        '/forecast/solar' + (select.value ? '?issued=' + encodeURIComponent(select.value) : ''),
        null,
        (error, r) => {
          if (seq !== generation) return;
          if (error || !Array.isArray(r?.issued)) {
            el('status').textContent = 'Solprognosen kunde inte läsas.';
            return;
          }
          if (!initialized) init(r.config);
          render(r);
        },
      );
    }
    enabled.onchange = () => {
      fields.disabled = !enabled.checked;
    };
    el('add').onclick = () => addRoof();
    select.onchange = load;
    el('form').onsubmit = (event) => {
      event.preventDefault();
      if (!initialized || el('save').disabled) return;
      const config = { enabled: enabled.checked };
      if (enabled.checked)
        Object.assign(config, {
          latitude: el('lat').valueAsNumber,
          longitude: el('lon').valueAsNumber,
          loss: el('loss').valueAsNumber,
          roofs: [...list.children].map((group) =>
            Object.fromEntries(
              [...group.querySelectorAll('input')].map((input) => [
                input.name,
                input.type === 'number' ? input.valueAsNumber : input.value.trim(),
              ]),
            ),
          ),
        });
      el('save').disabled = true;
      Homey.api('POST', '/forecast/solar/config', config, (error) => {
        el('save').disabled = false;
        el('message').textContent = error
          ? 'Inställningarna kunde inte sparas. Kontrollera fälten.'
          : 'Inställningarna har sparats.';
        if (!error) {
          select.value = '';
          load();
        }
      });
    };
    document.getElementById('tab-forecast').addEventListener('click', load);
    setInterval(() => {
      if (!document.getElementById('panel-forecast').hidden) load();
    }, 60000);
    if (!document.getElementById('panel-forecast').hidden) load();
  }
  root.SolarForecastView = { bind };
})(globalThis);
