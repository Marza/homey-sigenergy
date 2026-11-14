/* Uses the existing Tibber settings; credentials never pass through this UI. */
(function (root) {
  'use strict';
  function bind(Homey) {
    const el = (id) => document.getElementById('trade-' + id);
    const api = (method, path, body = null) =>
      new Promise((resolve, reject) =>
        Homey.api(method, path, body, (e, r) => (e ? reject(e) : resolve(r))),
      );
    const number = (n) => Number(n).toLocaleString('sv-SE', { maximumFractionDigits: 2 });
    const messages = {
      'dated-contract-required':
        'Ange ett giltighetsdatum och publicera ett tidsbundet kostnadsunderlag i avsnittet Ekonomisk jämförelse.',
      'not-configured': 'Spara Tibber-token i befintliga Tibber-inställningar.',
      'select-home':
        'Ange Tibber Home ID i befintliga inställningar eller invänta ordinarie prishämtning.',
      'home-confirmation-required':
        'Bekräfta att befintligt Tibberhem gäller samma mätpunkt som Sigenergy.',
      'network-confirmation-required':
        'Kontrollera underlaget och bekräfta separat debiterade nätkomponenter igen.',
      'authorization-required': 'Kontrollera befintlig Tibber-token.',
      'graphql-error': 'Tibber kunde inte lämna historiken. Försök igen senare.',
      'rate-limited': 'Tibber begränsar anropen; appen väntar innan nästa försök.',
    };
    function failure(e) {
      el('costs').textContent = 'Kostnadsuppgifterna kunde inte uppdateras.';
      el('coverage').textContent = '';
      el('message').textContent =
        messages[e.message] ||
        'Åtgärden misslyckades. Kontrollera befintliga Tibber-inställningar.';
    }
    async function refresh() {
      const s = await api('GET', '/tibber/history-prices/status');
      el('status').textContent = !s.configured
        ? messages['not-configured']
        : !s.homeSelected
          ? messages['select-home']
          : !s.confirmed
            ? messages['home-confirmation-required']
            : 'Befintlig Tibber-anslutning används. Historik: ' +
              (messages[s.syncStatus] || s.syncStatus || 'väntar') +
              '. Pristimmar: ' +
              s.priceHours +
              '.';
      el('components').hidden = true;
      el('network').checked = !!s.includeNetwork;
      const r = await api('GET', '/economics/observed');
      el('costs').textContent = r.totals
        ? 'Vägledande timberäkning för ' +
          r.matchedHours +
          ' timmar: import ' +
          number(r.totals.importKWh) +
          ' kWh, kostnad ' +
          number(r.totals.importCostSek) +
          ' kr; export ' +
          number(r.totals.exportKWh) +
          ' kWh, ersättning ' +
          number(r.totals.exportRevenueSek) +
          ' kr; netto ' +
          number(r.totals.netCostSek) +
          ' kr. ' +
          (r.componentBasis === 'tibber-trade-only'
            ? 'Endast rapporterade elhandelspriser.'
            : 'Avgifter enligt tidsbundna kostnadsversioner.')
        : 'Ingen kostnadssumma: ' + (messages[r.status] || r.status);
      el('coverage').textContent =
        'Saknar daterat underlag: ' +
        (r.missingContractHours || 0) +
        ' timmar. Saknar köppris: ' +
        (r.missingPriceHours || 0) +
        ' timmar, säljpris: ' +
        (r.missingProductionHours || 0) +
        ' timmar. Kompletta kvart utanför hela timmar: ' +
        (r.unusedEnergyQuarters || 0) +
        '. Ofullständiga energikvart: ' +
        (r.excludedEnergyQuarters || 0) +
        ', luckor: ' +
        (r.missingEnergyQuarters || 0) +
        '.';
    }
    function action(id, fn) {
      el(id).onclick = async () => {
        el(id).disabled = true;
        el('message').textContent = '';
        try {
          await fn();
          await refresh();
        } catch (e) {
          failure(e);
        } finally {
          el(id).disabled = false;
        }
      };
    }
    action('confirm', async () => {
      await api('POST', '/tibber/history-prices/confirm', { confirmSamePlant: el('same').checked });
      await api('POST', '/tibber/history-prices/refresh');
    });
    action('save-network', () =>
      api('POST', '/tibber/history-prices/components', {
        includeNetwork: el('network').checked,
        confirmSeparateNetworkComponents: el('confirm-network').checked,
      }),
    );
    action('refresh', () => api('POST', '/tibber/history-prices/refresh'));
    refresh().catch(failure);
  }
  root.TibberHistoryPricesSettings = { bind };
})(globalThis);
