(function (root) {
  'use strict';
  const KEY = 'householdImportLimits';
  function bind(Homey, onSaved) {
    const field = (key) => document.getElementById('household-' + key);
    const limit = field('import-limit');
    const fuse = field('main-fuse');
    const button = field('save-limits');
    const status = field('limits-status');
    let edited = false;

    limit.oninput = fuse.oninput = () => {
      edited = true;
      status.textContent = 'Spara ändringarna för att använda dem i jämförelsen.';
    };
    Homey.get(KEY, (error, value) => {
      if (edited) return;
      if (error) {
        status.textContent = 'Sparade importgränser kunde inte läsas.';
        return;
      }
      limit.value = value?.importLimitKW ?? '';
      fuse.value = value?.mainFuseA ?? '';
    });
    button.onclick = () => {
      if (button.disabled) return;
      edited = true;
      const text = limit.value.trim().replace(',', '.');
      const importLimitKW = text ? Number(text) : null;
      const mainFuseA = fuse.value ? Number(fuse.value) : null;
      if (
        (importLimitKW !== null &&
          (!Number.isFinite(importLimitKW) || importLimitKW <= 0 || importLimitKW > 1000)) ||
        !fuse.checkValidity()
      ) {
        status.textContent = 'Ange en positiv importgräns och huvudsäkring i hela ampere.';
        return;
      }

      button.disabled = limit.disabled = fuse.disabled = true;
      Homey.set(KEY, { importLimitKW, mainFuseA }, (error) => {
        button.disabled = limit.disabled = fuse.disabled = false;
        status.textContent = error
          ? 'Importgränserna kunde inte sparas.'
          : 'Hushållets importgränser sparades.';
        if (!error) onSaved();
      });
    };
  }
  root.HouseholdSettings = { bind };
})(globalThis);
