(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SolarPreview = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function bind(Homey, environment = globalThis) {
    const { document, Date: Clock, setTimeout, clearTimeout, setInterval } = environment;
    const el = (id) => document.getElementById(id);
    const button = el('previewSolar');
    let generation = 0,
      expiration,
      pending,
      displayed = false;
    const clear = (message) => {
      generation++;
      displayed = false;
      if (expiration !== undefined) clearTimeout(expiration);
      if (pending !== undefined) clearTimeout(pending);
      button.disabled = false;
      el('solarPreviewRows').replaceChildren();
      el('solarPreviewContext').textContent = '';
      el('solarPreviewAssumptions').textContent = '';
      el('solarPreviewStatus').textContent = message;
    };
    const numeric = (id) => {
      if (!el(id).value.trim()) throw Error('Fyll i alla aktiva antaganden.');
      const value = Number(el(id).value);
      if (!Number.isFinite(value)) throw Error('Ange giltiga tal.');
      return value;
    };
    const invalidate = () => {
      el('solarHomeFields').disabled = !el('solarHomeEnabled').checked;
      el('solarEvFields').disabled = !el('solarEvConnected').checked;
      clear('Indata ändrade. Beräkna en ny förhandsvisning.');
    };
    for (const id of [
      'solarPriority',
      'solarMinutes',
      'solarHomeEnabled',
      'solarHomeTarget',
      'solarHomeMax',
      'solarHomeEfficiency',
      'solarEvConnected',
      'solarEvSoc',
      'solarEvObserved',
      'solarEvTarget',
      'solarEvCurrent',
      'solarEvMin',
      'solarEvMax',
    ]) {
      el(id).oninput = invalidate;
      el(id).onchange = invalidate;
    }
    el('solarEvStamp').onclick = () => {
      const date = new Clock();
      el('solarEvObserved').value = new Clock(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
      invalidate();
    };
    button.onclick = () => {
      clear('Beräknar…');
      let input;
      try {
        const home = { enabled: el('solarHomeEnabled').checked };
        if (home.enabled)
          Object.assign(home, {
            targetSoc: numeric('solarHomeTarget'),
            maxPowerKW: numeric('solarHomeMax'),
            efficiency: numeric('solarHomeEfficiency'),
          });
        const ev = { connected: el('solarEvConnected').checked };
        if (ev.connected) {
          if (!el('solarEvObserved').value.trim()) throw Error('Ange avläsningstid för bil-SoC.');
          Object.assign(ev, {
            soc: numeric('solarEvSoc'),
            targetSoc: numeric('solarEvTarget'),
            currentPowerKW: numeric('solarEvCurrent'),
            minPowerKW: numeric('solarEvMin'),
            maxPowerKW: numeric('solarEvMax'),
            observedAt: new Clock(el('solarEvObserved').value).toISOString(),
          });
        }
        input = {
          priority: el('solarPriority').value,
          durationMinutes: numeric('solarMinutes'),
          home,
          ev,
        };
      } catch (error) {
        clear(error.message);
        return;
      }
      const current = generation;
      button.disabled = true;
      pending = setTimeout(() => {
        if (current === generation) clear('Förhandsvisningen kunde inte hämtas. Försök igen.');
      }, 8000);
      Homey.api('POST', '/solar/preview', input, (error, result) => {
        if (current !== generation) return;
        clearTimeout(pending);
        button.disabled = false;
        if (error) {
          clear(error.message || 'Beräkningen misslyckades.');
          return;
        }
        const labels = {
          'backup-restricted': 'Pausad: nätläge saknas eller reservläge är aktivt.',
          'unavailable-source':
            'Färska och giltiga nät-, sol- och batterivärden från en enda anläggning krävs.',
        };
        if (labels[result?.status]) {
          clear(labels[result.status]);
          return;
        }
        const expiry = Clock.parse(result?.validUntil);
        const available = result?.budget?.availableSolarKW;
        const destinations = ['home', 'ev', 'export'];
        const rows = result?.allocations;
        if (
          !['preview', 'no-surplus'].includes(result?.status) ||
          result.advisoryOnly !== true ||
          result.controlApplied !== false ||
          !Number.isFinite(expiry) ||
          expiry <= Clock.now() ||
          !Number.isFinite(available) ||
          available < 0 ||
          !Array.isArray(rows) ||
          rows.length !== 3 ||
          !destinations.every((d) => rows.filter((r) => r.destination === d).length === 1) ||
          rows.some(
            (r) =>
              !Number.isFinite(r.additionalKW) ||
              r.additionalKW < 0 ||
              !Number.isFinite(r.inputKWh) ||
              r.inputKWh < 0 ||
              (r.destination !== 'export' && (!Number.isFinite(r.storedKWh) || r.storedKWh < 0)),
          ) ||
          Math.abs(rows.reduce((sum, r) => sum + r.additionalKW, 0) - available) > 0.00001 ||
          !result.observed ||
          !result.assumptions?.consumers
        ) {
          clear('Ogiltigt eller inaktuellt svar. Beräkna på nytt.');
          return;
        }
        displayed = true;
        const fmt = (value) =>
          Number.isFinite(value)
            ? value.toLocaleString('sv-SE', { maximumFractionDigits: 3 })
            : '–';
        const o = result.observed,
          a = result.assumptions;
        el('solarPreviewStatus').textContent =
          result.status === 'no-surplus'
            ? 'Inget extra solutrymme i pågående export · Ingen styrning'
            : 'Preliminär fördelning av extra solutrymme · Ingen styrning';
        el('solarPreviewContext').textContent =
          `Avläst ${new Clock(o.readAt).toLocaleTimeString('sv-SE')}. Sol ${fmt(o.pvKW)} kW (${{ self: 'egen PV', 'third-party': 'tredjepartsinverter', combined: 'egen PV + tredjepartsinverter' }[o.solarSource] || 'okänd solkälla'}), nät ${fmt(o.gridKW)} kW (+ import / − export), hemmabatteri ${fmt(o.homeBatteryKW)} kW (+ laddning). Tillgängligt för extra fördelning: ${fmt(available)} kW. Export som inte räknas som solutrymme: ${fmt(result.budget.excludedExportKW)} kW.`;
        const ev = a.consumers.ev;
        const home = a.consumers.home;
        el('solarPreviewAssumptions').textContent =
          `${a.durationMinutes} minuter med oförändrade flöden, ${a.priority === 'home-first' ? 'batteri först' : 'bil först'}. Pågående laddning fortsätter och ingår inte i extrafördelningen. ${home ? `Hem­batteri: avläst SoC ${fmt(o.homeSoc)} %, ${fmt(home.capacityKWh)} kWh, mål ${fmt(home.targetSoc)} % och antagen laddverkningsgrad ${fmt(home.efficiency * 100)} %. ${home.dischargeBlocked ? 'Extra hemmabatteriladdning är pausad eftersom batteriet laddar ur.' : ''}` : 'Ingen extra laddning av hemmabatteriet antas.'} ${ev ? `Bil: manuell SoC ${fmt(ev.soc)} %, ${fmt(ev.capacityKWh)} kWh och ${fmt(ev.efficiency * 100)} % laddverkningsgrad från sparade bilinställningar.` : 'Ingen extra billaddning antas.'} Ingen prognos, ekonomisk optimering eller säkringskontroll.`;
        for (const row of rows) {
          const tr = document.createElement('tr');
          for (const value of [
            {
              home: 'Extra till hemmabatteri',
              ev: 'Extra till bil',
              export: 'Kvar av solutrymmet till export',
            }[row.destination],
            `${fmt(row.additionalKW)} kW`,
            `${fmt(row.inputKWh)} kWh`,
            row.destination === 'export' ? '–' : `${fmt(row.storedKWh)} kWh`,
          ]) {
            const td = document.createElement('td');
            td.textContent = value;
            tr.appendChild(td);
          }
          el('solarPreviewRows').appendChild(tr);
        }
        expiration = setTimeout(
          () => clear('Mätunderlaget har blivit inaktuellt. Beräkna på nytt.'),
          Math.min(30000, expiry - Clock.now()),
        );
      });
    };
    // Recompute only while a valid preview is displayed. Errors/edits stop refresh.
    setInterval(() => {
      if (displayed) button.onclick();
    }, 10000);
    invalidate();
    el('solarPreviewStatus').textContent = 'Ingen förhandsvisning beräknad.';
  }
  return { bind };
});
