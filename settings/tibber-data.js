/* Private settings UI. Tokens and PKCE verifiers remain in the app backend. */
(function (root) {
  'use strict';
  function bind(Homey) {
    const el = (id) => document.getElementById('data-' + id);
    let polling;
    const api = (method, path, body = null) =>
      new Promise((resolve, reject) =>
        Homey.api(method, path, body, (e, r) => (e ? reject(e) : resolve(r))),
      );
    const number = (n) => Number(n).toLocaleString('sv-SE', { maximumFractionDigits: 2 });
    const messages = {
      'authorization-required': 'Logga in igen för att ge appen åtkomst.',
      'scope-or-prices-unavailable': 'Behörighet saknas eller Tibber saknar priser för perioden.',
      'rate-limited': 'Tibber begränsar anropen. Appen väntar innan nästa försök.',
      'network-confirmation-required':
        'Kontrollera kostnadsunderlaget och bekräfta nätkomponenterna igen.',
    };
    const error = (e) => {
      el('costs').textContent = 'Kostnadsuppgifterna kunde inte uppdateras.';
      el('coverage').textContent = '';
      el('message').textContent =
        messages[e.message] || 'Åtgärden misslyckades. Kontrollera anslutning och inställningar.';
    };
    async function loadHomes() {
      const homes = await api('GET', '/tibber/data/homes');
      el('home').replaceChildren();
      for (const h of homes) {
        const option = document.createElement('option');
        option.value = h.id;
        option.textContent = h.name || h.id;
        el('home').appendChild(option);
      }
    }
    async function refresh() {
      const s = await api('GET', '/tibber/data/status');
      el('status').textContent = s.authStatus
        ? 'Inloggning: ' + s.authStatus
        : s.connected
          ? s.homeId
            ? 'Ansluten. Prishämtning: ' +
              (s.syncStatus || 'väntar') +
              '. Prisintervall: ' +
              s.priceRows
            : 'Inloggad. Välj hem och bekräfta mätpunkten nedan.'
          : 'Inte ansluten till Tibber Data API.';
      el('selection').hidden = !s.connected;
      el('components').hidden = !s.homeId;
      if (s.clientId && !el('client').value) el('client').value = s.clientId;
      if (s.connected && (!el('home').options.length || !s.homeId)) await loadHomes();
      if (s.homeId) el('home').value = s.homeId;
      el('network').checked = !!s.includeNetwork;
      const ledger = await api('GET', '/economics/observed');
      el('costs').textContent = ledger.totals
        ? 'Täckta kvart: ' +
          ledger.matchedQuarters +
          '. Import ' +
          number(ledger.totals.importKWh) +
          ' kWh, kostnad ' +
          number(ledger.totals.importCostSek) +
          ' kr. Export ' +
          number(ledger.totals.exportKWh) +
          ' kWh, ersättning ' +
          number(ledger.totals.exportRevenueSek) +
          ' kr. Netto ' +
          number(ledger.totals.netCostSek) +
          ' kr. ' +
          (ledger.componentBasis === 'tibber-trade-only'
            ? 'Endast Tibbers elhandel.'
            : 'Inklusive bekräftade nätkomponenter.')
        : 'Inga kostnadssummor: ' + (messages[ledger.status] || ledger.status);
      el('coverage').textContent =
        'Status: ' +
        ledger.status +
        '. Saknar köppris: ' +
        (ledger.missingPriceQuarters || 0) +
        ', säljpris: ' +
        (ledger.missingProductionQuarters || 0) +
        ', fel momssats: ' +
        (ledger.vatMismatchQuarters || 0) +
        '. Ofullständiga energikvart: ' +
        (ledger.excludedEnergyQuarters || 0) +
        ', luckor: ' +
        (ledger.missingEnergyQuarters || 0) +
        '.';
      if (!s.authStatus && polling) {
        clearInterval(polling);
        polling = null;
        el('login').hidden = true;
      }
    }
    function action(id, fn) {
      el(id).onclick = async () => {
        el(id).disabled = true;
        el('message').textContent = '';
        try {
          await fn();
          await refresh();
        } catch (e) {
          error(e);
        } finally {
          el(id).disabled = false;
        }
      };
    }
    action('connect', async () => {
      const r = await api('POST', '/tibber/data/connect', { clientId: el('client').value.trim() });
      el('login').href = r.url;
      el('login').hidden = false;
      if (polling) clearInterval(polling);
      polling = setInterval(() => refresh().catch(error), 5000);
    });
    action('select', async () => {
      await api('POST', '/tibber/data/home', {
        homeId: el('home').value,
        confirmSamePlant: el('same').checked,
      });
      await api('POST', '/tibber/data/refresh');
    });
    action('save-network', () =>
      api('POST', '/tibber/data/components', {
        includeNetwork: el('network').checked,
        confirmSeparateNetworkComponents: el('confirm-network').checked,
      }),
    );
    action('refresh', () => api('POST', '/tibber/data/refresh'));
    action('disconnect', async () => {
      await api('POST', '/tibber/data/disconnect');
      el('home').replaceChildren();
    });
    window.addEventListener('pagehide', () => {
      if (polling) clearInterval(polling);
    });
    refresh().catch(error);
  }
  root.TibberDataSettings = { bind };
})(globalThis);
