/* Private advisory settings. No hardware commands or automatic scenario ranking. */
(function (root) {
  'use strict';
  function bind(Homey) {
    const el = (id) => document.getElementById('econ-' + id),
      fmt = (n) => Number(n).toLocaleString('sv-SE', { maximumFractionDigits: 2 });
    let state = null;
    const messages = {
      'contract-inputs-changed':
        'Ingen ny kostnadsversion sparades eftersom sparade villkor eller versioner har ändrats. Tryck Läs om sparade villkor och versioner, kontrollera underlaget och bekräfta på nytt innan du publicerar.',
      'confirm-contract-provenance': 'Bekräfta giltighetsdatum och prisernas kostnadsinnehåll.',
      'contract-dates-must-increase':
        'Ange ett giltigt startdatum efter den senast publicerade versionens startdatum.',
      'incompatible-network-components':
        'Separata nättillägg kräver ett spotprisunderlag utan inkluderad energiskatt.',
      'contract-restore-conflict': 'Filen har andra villkor för ett redan publicerat startdatum.',
      'contract-restore-would-rewrite-period':
        'Återläsningen skulle ändra en redan publicerad giltighetsperiod.',
      'confirm-contract-restore':
        'Bekräfta att filen gäller samma anläggning och läs om versionerna.',
    };
    const explain = (reason) => messages[reason] || reason || 'Underlaget är otillräckligt.';
    function api(method, path, body = null) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(
              Error(
                'Svar saknas. Åtgärden kan ha genomförts; läs om versionerna före nytt försök.',
              ),
            );
          }
        }, 15000);
        Homey.api(method, path, body, (e, r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (e) reject(e);
          else resolve(r);
        });
      });
    }
    function invalidateContracts() {
      state = null;
      el('date-confirm').checked = false;
      el('components-confirm').checked = false;
      for (const id of ['publish', 'export', 'import']) el(id).disabled = true;
    }
    async function load() {
      const previous = state;
      state = null;
      for (const id of ['publish', 'export', 'import']) el(id).disabled = true;
      el('refresh-message').textContent = 'Läser sparade villkor och versioner…';
      let next;
      try {
        next = await api('GET', '/economics/contracts');
        if (!Array.isArray(next?.timeline?.entries) || !next.revision || !next.draftHash)
          throw Error('Ogiltigt versionssvar.');
      } catch (e) {
        invalidateContracts();
        el('refresh-message').textContent = 'Omläsningen misslyckades: ' + explain(e.message);
        throw e;
      }
      if (
        previous &&
        (previous.revision !== next.revision || previous.draftHash !== next.draftHash)
      )
        invalidateContracts();
      state = next;
      el('refresh-message').textContent =
        'Sparade villkor och versioner har lästs in. Antal publicerade kostnadsversioner: ' +
        state.timeline.entries.length +
        '. Kontrollera datum och bekräftelser och tryck Publicera daterad kopia av sparade villkor för att spara en ny version.';
      el('contracts').replaceChildren();
      for (let i = 0; i < state.timeline.entries.length; i++) {
        const e = state.timeline.entries[i],
          row = document.createElement('li');
        row.textContent =
          e.from +
          ' till ' +
          (state.timeline.entries[i + 1]?.from || 'nästa version') +
          ' (slutdatum exkluderat): ' +
          e.contract.source +
          '. Effektpris ' +
          fmt(e.tariff.rateSekPerKw) +
          ' kr/kW. ' +
          (e.includeNetwork
            ? 'Separata nät-/skattetillägg.'
            : 'Endast rapporterat elhandelspris samt slitage.');
        el('contracts').appendChild(row);
      }
      el('contract-message').textContent =
        state.timeline.entries.length +
        ' daterade kostnadsversioner. Saknade äldre perioder får inga antagna villkor.';
      for (const id of ['publish', 'export', 'import']) el(id).disabled = false;
    }
    for (const id of ['publish', 'export', 'import']) el(id).disabled = true;
    function action(id, fn) {
      el(id).onclick = async () => {
        el(id).disabled = true;
        try {
          await fn();
        } catch (e) {
          if (e.message === 'contract-inputs-changed') invalidateContracts();
          el('contract-message').textContent = explain(e.message);
        } finally {
          el(id).disabled = ['publish', 'export', 'import'].includes(id) && !state;
        }
      };
    }
    action('refresh', load);
    action('publish', async () => {
      if (!state) throw Error('Läs om versionerna först.');
      await api('POST', '/economics/contracts', {
        expectedRevision: state.revision,
        draftHash: state.draftHash,
        from: el('from').value,
        confirmEffectiveDate: el('date-confirm').checked,
        confirmTradeComponents: el('components-confirm').checked,
        includeNetwork: el('network').checked,
      });
      await load();
    });
    action('export', async () => {
      await load();
      const url = URL.createObjectURL(
          new Blob([JSON.stringify(state.timeline, null, 2)], { type: 'application/json' }),
        ),
        a = document.createElement('a');
      a.href = url;
      a.download = 'sigenergy-cost-versions.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    action('import', async () => {
      const file = el('import-file').files?.[0];
      if (!file || file.size > 262144) throw Error('Välj en kostnadsfil på högst 256 KiB.');
      if (!state) throw Error('Läs om versionerna först.');
      const timeline = JSON.parse(await file.text());
      await api('POST', '/economics/contracts/restore', {
        timeline,
        expectedRevision: state.revision,
        confirmSamePlant: el('import-confirm').checked,
      });
      await load();
    });
    load().catch((e) => {
      state = null;
      el('contract-message').textContent = explain(e.message);
    });
  }
  root.ContractVersions = { bind };
})(globalThis);
