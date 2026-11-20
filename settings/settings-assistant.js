(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SettingsAssistant = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function bind(document) {
    const idle = { refreshWeekdays() {}, refreshUnits() {}, reveal() {} };
    if (!document.querySelectorAll('.settings-page').length) return idle;
    const el = (id) => document.getElementById(id);
    const emit = (input) => {
      input.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
      input.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
    };
    function reveal(input) {
      for (let node = input?.parentElement; node; node = node.parentElement)
        if (node.tagName === 'DETAILS') node.open = true;
      input?.focus();
    }
    const days = [...document.querySelectorAll('[data-tariff-weekday]')];
    const presets = [...document.querySelectorAll('[data-weekday-preset]')];
    function refreshWeekdays() {
      const raw = el('tariffWeekdays').value;
      const selected = raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      for (const day of days) {
        day.checked = selected.includes(day.dataset.tariffWeekday);
        day.disabled = false;
      }
      for (const preset of presets) preset.disabled = false;
    }
    const writeDays = () => {
      el('tariffWeekdays').value = days
        .filter((day) => day.checked)
        .map((day) => day.dataset.tariffWeekday)
        .join(',');
      emit(el('tariffWeekdays'));
    };
    for (const day of days) day.addEventListener('change', writeDays);
    for (const preset of presets)
      preset.addEventListener('click', () => {
        for (const day of days)
          day.checked =
            preset.dataset.weekdayPreset === 'all' ||
            (Number(day.dataset.tariffWeekday) >= 1 && Number(day.dataset.tariffWeekday) <= 5);
        writeDays();
      });
    el('costSetToday').addEventListener('click', () => {
      const now = new Date();
      el('costCheckedOn').value = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('-');
      emit(el('costCheckedOn'));
    });
    const number = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 8 });
    for (const output of document.querySelectorAll('[data-unit-preview-for]')) {
      const input = el(output.dataset.unitPreviewFor);
      output.id = 'unit-preview-' + input.id;
      input.setAttribute(
        'aria-describedby',
        [input.getAttribute('aria-describedby'), output.id].filter(Boolean).join(' '),
      );
      const update = () => refreshUnit(output);
      input.addEventListener('input', update);
      input.addEventListener('change', update);
    }
    function refreshUnit(output) {
      const input = el(output.dataset.unitPreviewFor),
        raw = input.value.trim(),
        value = Number(raw.replace(',', '.'));
      output.hidden = !raw || !Number.isFinite(value);
      output.textContent = output.hidden
        ? ''
        : 'Motsvarar ' +
          number.format(value * 100) +
          (output.dataset.unit === 'ore' ? ' öre/kWh.' : ' %.');
    }
    // Host callbacks populate values asynchronously; conversion never edits an input.
    function refreshUnits() {
      for (const output of document.querySelectorAll('[data-unit-preview-for]'))
        refreshUnit(output);
    }
    for (const id of ['saveCostContract', 'saveTariff'])
      el(id).addEventListener(
        'click',
        () => {
          const page = el(id).closest('.settings-page');
          const first = [...page.querySelectorAll('input,select')].find(
            (input) => input.willValidate && !input.checkValidity(),
          );
          if (first) reveal(first);
        },
        true,
      );
    return { refreshWeekdays, refreshUnits, reveal };
  }
  return { bind };
});
