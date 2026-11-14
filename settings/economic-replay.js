/* Private advisory settings. No hardware commands or automatic scenario ranking. */
(function (root) {
  'use strict';
  function bind(Homey) {
    const el = (id) => document.getElementById('econ-' + id),
      fmt = (n) => Number(n).toLocaleString('sv-SE', { maximumFractionDigits: 2 });
    let state = null,
      run = 0;
    const messages = {
      'ambiguous-solar-plant': 'Exakt en parad Sigenergy-anläggning krävs för sol/bil-modellen.',
      'confirm-historical-ev-baseline':
        'Bekräfta det hypotetiska laddscenariot och att perioden saknar befintlig billaddning.',
      'incomplete-solar-ev-window':
        'Perioden saknar komplett solunderlag, har inkonsekventa solvärden eller innehåller uppmätt billaddning.',
      'ev-target-below-saved-minimum': 'Bilens mål måste minst motsvara sparad minsta SoC.',
      'ev-deadline-unmet':
        'Bilens laddmål kunde inte nås före den antagna avgången. Kostnadsskillnaden hålls därför okänd.',
      'invalid-solar-comparison-input':
        'Sol/bil-modellen tillåter 1–168 timmar och högst 10 olika effekttak.',
      'invalid-solar-ev-assumptions':
        'Kontrollera solmålet, sparade bilinställningar, bilens SoC, laddeffekter och tidsfönster.',
      'contract-inputs-changed':
        'Sparade villkor har ändrats. Läs om versionerna och kontrollera underlaget innan du publicerar.',
      'confirm-contract-provenance': 'Bekräfta giltighetsdatum och prisernas kostnadsinnehåll.',
      'contract-dates-must-increase':
        'Ange ett giltigt startdatum efter den senast publicerade versionens startdatum.',
      'incompatible-network-components':
        'Separata nättillägg kräver ett spotprisunderlag utan inkluderad energiskatt.',
      'dated-contract-required': 'Publicera ett kostnadsunderlag med giltighetsdatum för perioden.',
      'incomplete-comparison-window':
        'Perioden saknar komplett energi-, batteri-, pris- eller avtalsunderlag.',
      'terminal-energy-not-restored':
        'Husbatteriets slutenergi matchar inte startenergin. Välj en längre period eller justera antagandena.',
      'insufficient-demand-peaks': 'Det finns för få timtoppar för den sparade effekttariffen.',
      'tariff-changed-within-month':
        'Effekttariffen ändras inom samma månad. En sådan månadsavgift kan inte jämföras här.',
      'historical-prices-unavailable': 'Hämta historiska Tibber-priser först.',
      'tibber-home-not-confirmed': 'Bekräfta Tibberhemmet i avsnittet för historiska priser.',
      'contract-restore-conflict': 'Filen har andra villkor för ett redan publicerat startdatum.',
      'contract-restore-would-rewrite-period':
        'Återläsningen skulle ändra en redan publicerad giltighetsperiod.',
      'confirm-contract-restore':
        'Bekräfta att filen gäller samma anläggning och läs om versionerna.',
      'invalid-comparison-data': 'Kontrollera indata, sparade villkor och batteriparametrar.',
      'invalid-battery-assumptions':
        'Kontrollera kapacitet, startenergi, reserv, effekter och verkningsgrader.',
    };
    const missingLabels = {
      energyQuarters: 'energi',
      batteryCoverageQuarters: 'batteritäckning',
      contractQuarters: 'avtal',
      purchasePriceQuarters: 'köppris',
      productionPriceQuarters: 'säljpris',
      solarCoverageQuarters: 'soltäckning',
      solarEnergyQuarters: 'solenergi',
      knownEvChargingQuarters: 'befintlig billaddning',
      inconsistentSolarQuarters: 'inkonsekventa solvärden',
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
    function clearResults() {
      run++;
      el('results').replaceChildren();
      el('result').textContent = 'Jämförelsen behöver beräknas på nytt.';
    }
    async function load() {
      state = await api('GET', '/economics/contracts');
      if (!state?.timeline?.entries) throw Error('Ogiltigt versionssvar.');
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
          el('contract-message').textContent = explain(e.message);
        } finally {
          el(id).disabled = false;
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
      clearResults();
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
      clearResults();
      await load();
    });
    const num = (id) => {
      const raw = String(el(id).value ?? '').trim();
      if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(raw))
        throw Error('Fyll i giltiga batteri- och periodvärden.');
      return Number(raw.replace(',', '.'));
    };
    const inputs = [
      'hours',
      'caps',
      'capacity',
      'initial',
      'reserve',
      'charge',
      'discharge',
      'charge-eta',
      'discharge-eta',
      'model-confirm',
      'solar-enabled',
      'solar-target',
      'ev-initial',
      'ev-target',
      'ev-min',
      'ev-max',
      'ev-arrival',
      'ev-departure',
      'ev-history-confirm',
      'ev-absent-confirm',
    ];
    for (const id of inputs) {
      el(id).oninput = clearResults;
      el(id).onchange = clearResults;
    }
    const solarModeChanged = () => {
      el('solar-fields').disabled = !el('solar-enabled').checked;
      if (el('solar-enabled').checked && !el('ev-departure').value)
        el('ev-departure').value = el('hours').value;
      clearResults();
    };
    el('solar-enabled').oninput = solarModeChanged;
    el('solar-enabled').onchange = solarModeChanged;
    Homey.get('chargingConfig', (error, c) => {
      if (
        error ||
        !c ||
        ![c.usableBatteryKWh, c.chargingEfficiency, c.maxChargingPowerKW, c.minimumSoc].every(
          Number.isFinite,
        )
      ) {
        el('ev-config').textContent =
          'Spara och kontrollera bilens laddinställningar innan sol/bil-modellen används.';
        return;
      }
      el('ev-config').textContent =
        'Sparad bilkapacitet ' +
        fmt(c.usableBatteryKWh) +
        ' kWh, laddverkningsgrad ' +
        fmt(c.chargingEfficiency) +
        ', maxeffekt ' +
        fmt(c.maxChargingPowerKW) +
        ' kW och minsta mål-SoC ' +
        fmt(c.minimumSoc) +
        ' % används. Spara ändrade bilinställningar före jämförelsen.';
      if (!el('ev-max').value) el('ev-max').value = String(c.maxChargingPowerKW);
    });
    Homey.get('optimizerConfig', (error, c) => {
      if (error || !c) return;
      const values = {
        capacity: c.batteryCapacityKWh,
        'solar-target': c.batteryCapacityKWh,
        initial: (c.batteryCapacityKWh * c.initialSocPercent) / 100,
        reserve:
          (c.batteryCapacityKWh * Math.max(c.backupReservePercent, c.reserveMinPercent)) / 100,
        charge: c.maxChargeKW,
        discharge: c.maxDischargeKW,
        'charge-eta': Math.sqrt(c.roundTripEfficiency),
        'discharge-eta': Math.sqrt(c.roundTripEfficiency),
      };
      for (const [id, value] of Object.entries(values))
        if (Number.isFinite(value) && !el(id).value)
          el(id).value = String(Number(value.toFixed(6)));
    });
    el('run').onclick = async () => {
      clearResults();
      const generation = run;
      el('run').disabled = true;
      el('result').textContent = 'Beräknar…';
      try {
        const capsKW = el('caps')
          .value.split(';')
          .map((raw) => {
            if (!raw.trim()) throw Error('Ange effekttak separerade med semikolon.');
            return Number(raw.trim().replace(',', '.'));
          });
        const body = {
          hours: num('hours'),
          capsKW,
          confirmModelAssumptions: el('model-confirm').checked,
          battery: {
            capacityKWh: num('capacity'),
            initialKWh: num('initial'),
            reserveKWh: num('reserve'),
            maxChargeKW: num('charge'),
            maxDischargeKW: num('discharge'),
            chargeEfficiency: num('charge-eta'),
            dischargeEfficiency: num('discharge-eta'),
          },
        };
        const coupled = el('solar-enabled').checked;
        if (coupled) {
          body.battery.solarTargetKWh = num('solar-target');
          body.ev = {
            initialSoc: num('ev-initial'),
            targetSoc: num('ev-target'),
            minPowerKW: num('ev-min'),
            maxPowerKW: num('ev-max'),
            availableFromHours: num('ev-arrival'),
            deadlineHours: num('ev-departure'),
            confirmHistoricalTask: el('ev-history-confirm').checked,
            confirmNoExistingEvCharging: el('ev-absent-confirm').checked,
          };
        }
        const r = await api(
          'POST',
          coupled ? '/economics/solar-ev-replay' : '/economics/replay',
          body,
        );
        if (generation !== run) return;
        if (!Array.isArray(r?.candidates)) {
          el('result').textContent =
            explain(r?.reason) +
            (r?.missing
              ? ' Saknade/uteslutna kvart: ' +
                Object.entries(r.missing)
                  .filter(([k, v]) => missingLabels[k] && Number.isInteger(v))
                  .map(([k, v]) => missingLabels[k] + ' ' + v)
                  .join(', ') +
                '.'
              : '');
          return;
        }
        const moneyFields = [
          'importKWh',
          'exportKWh',
          'importCostSek',
          'exportRevenueSek',
          'energySek',
          'wearSek',
        ];
        if (
          !Number.isSafeInteger(r.from) ||
          !Number.isSafeInteger(r.to) ||
          !Array.isArray(r.contractVersions) ||
          !r.candidates.length ||
          r.candidates.length > 20 ||
          r.candidates.some(
            (c) =>
              ![
                'capKW',
                'chargedKWh',
                'dischargedKWh',
                'lossesKWh',
                'initialStoredKWh',
                'finalStoredKWh',
                'uncoveredKWh',
              ].every((k) => Number.isFinite(c[k])) ||
              ![c.baseline, c.scenario].every(
                (v) =>
                  v &&
                  moneyFields.every((k) => Number.isFinite(v[k])) &&
                  v.demand &&
                  Array.isArray(v.demand.months),
              ) ||
              (c.indicativeNetDifferenceSek !== null &&
                !Number.isFinite(c.indicativeNetDifferenceSek)),
          )
        )
          throw Error('Ogiltigt beräkningssvar.');
        if (
          coupled &&
          (r.mode !== 'coupled-solar-ev' ||
            r.candidates.length !== capsKW.length * 2 ||
            !capsKW.every((cap) =>
              ['home-first', 'ev-first'].every(
                (strategy) =>
                  r.candidates.filter((c) => c.capKW === cap && c.strategy === strategy).length ===
                  1,
              ),
            ) ||
            !r.evAssumptions ||
            !['capacityKWh', 'efficiency', 'minPowerKW', 'maxPowerKW'].every((k) =>
              Number.isFinite(r.evAssumptions[k]),
            ) ||
            r.candidates.some(
              (c) =>
                !['home-first', 'ev-first'].includes(c.strategy) ||
                !c.ev ||
                !c.solar ||
                ![
                  'targetStoredKWh',
                  'finalStoredKWh',
                  'inputKWh',
                  'lossesKWh',
                  'unmetKWh',
                  'deadlineHours',
                ].every((k) => Number.isFinite(c.ev[k])) ||
                ![
                  'generationKWh',
                  'toHouseKWh',
                  'toEvKWh',
                  'toHomeKWh',
                  'exportKWh',
                  'evNonSolarKWh',
                ].every((k) => Number.isFinite(c.solar[k])),
            ))
        )
          throw Error('Ogiltigt sol/bil-svar.');
        const date = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' });
        el('result').textContent =
          'Period ' +
          date(r.from) +
          ' – ' +
          date(r.to) +
          '. Indikativ modell; ingen ekonomisk rangordning. ' +
          r.contractVersions.length +
          ' kostnadsversioner.' +
          (coupled
            ? ' Historiskt exempel med hypotetisk bil: referensen laddar tidigt med passivt husbatteri. Samma laddmål och avgång jämförs.'
            : '');
        if (coupled)
          el('result').textContent +=
            ' Bilantaganden: ' +
            fmt(r.evAssumptions.capacityKWh) +
            ' kWh, laddverkningsgrad ' +
            fmt(r.evAssumptions.efficiency) +
            ', aktiv laddeffekt ' +
            fmt(r.evAssumptions.minPowerKW) +
            '–' +
            fmt(r.evAssumptions.maxPowerKW) +
            ' kW.';
        for (const c of r.candidates) {
          const card = document.createElement('article'),
            title = document.createElement('h4');
          title.textContent =
            (c.strategy
              ? c.strategy === 'home-first'
                ? 'Batteri först · '
                : 'Bil först · '
              : '') +
            'Effekttak ' +
            fmt(c.capKW) +
            ' kW';
          card.appendChild(title);
          const line = (text) => {
            const p = document.createElement('p');
            p.textContent = text;
            card.appendChild(p);
          };
          line(
            'Husbatteri: laddat ' +
              fmt(c.chargedKWh) +
              ' kWh, levererat ' +
              fmt(c.dischargedKWh) +
              ' kWh, förluster ' +
              fmt(c.lossesKWh) +
              ' kWh. Batteri: ' +
              fmt(c.initialStoredKWh) +
              ' → ' +
              fmt(c.finalStoredKWh) +
              ' kWh. Ej kapad energi: ' +
              fmt(c.uncoveredKWh) +
              ' kWh.',
          );
          if (c.ev) {
            line(
              'Bilens lagrade energi vid avgång: ' +
                fmt(c.ev.finalStoredKWh) +
                ' / ' +
                fmt(c.ev.targetStoredKWh) +
                ' kWh. Antagen avgång efter ' +
                fmt(c.ev.deadlineHours) +
                ' timmar. Bilens laddenergi ' +
                fmt(c.ev.inputKWh) +
                ' kWh, laddförluster ' +
                fmt(c.ev.lossesKWh) +
                ' kWh, ej uppnått mål ' +
                fmt(c.ev.unmetKWh) +
                ' kWh.',
            );
            line(
              'Vald solproduktion ' +
                fmt(c.solar.generationKWh) +
                ' kWh. Före laddförluster: direkt till hushåll ' +
                fmt(c.solar.toHouseKWh) +
                ' kWh, till bil ' +
                fmt(c.solar.toEvKWh) +
                ' kWh, till husbatteri ' +
                fmt(c.solar.toHomeKWh) +
                ' kWh, kvarvarande export ' +
                fmt(c.solar.exportKWh) +
                ' kWh. Bilens övriga matning ' +
                fmt(c.solar.evNonSolarKWh) +
                ' kWh kan komma från nät eller husbatteri.',
            );
          }
          for (const [key, label] of [
            [
              'baseline',
              coupled ? 'Referens: bilen laddas tidigt, passivt husbatteri' : 'Utan aktivt batteri',
            ],
            ['scenario', 'Med modellerat batteri'],
          ]) {
            const v = c[key];
            line(
              label +
                ': import ' +
                fmt(v.importKWh) +
                ' kWh / ' +
                fmt(v.importCostSek) +
                ' kr, export ' +
                fmt(v.exportKWh) +
                ' kWh / ' +
                fmt(v.exportRevenueSek) +
                ' kr, nettoenergi ' +
                fmt(v.energySek) +
                ' kr, slitage ' +
                fmt(v.wearSek) +
                ' kr, preliminär effektavgift ' +
                (v.demand.status === 'provisional'
                  ? fmt(v.demand.totalSek) + ' kr'
                  : 'saknar underlag') +
                '.',
            );
          }
          line(
            c.indicativeNetDifferenceSek === null
              ? explain(c.reason)
              : 'Indikativ kostnadsskillnad: ' +
                  fmt(c.indicativeNetDifferenceSek) +
                  ' kr. Positivt betyder lägre modellerad kostnad.',
          );
          for (const m of c.scenario.demand.months || [])
            line(
              m.month +
                ': ' +
                m.coverage.completeHours +
                ' kompletta effekttimmar, ' +
                m.coverage.missingHours +
                ' saknade och ' +
                m.coverage.pendingHours +
                ' återstående.',
            );
          el('results').appendChild(card);
        }
      } catch (e) {
        if (generation === run) el('result').textContent = explain(e.message);
      } finally {
        el('run').disabled = false;
      }
    };
    load().catch((e) => {
      state = null;
      el('contract-message').textContent = explain(e.message);
    });
  }
  root.EconomicReplaySettings = { bind };
})(globalThis);
