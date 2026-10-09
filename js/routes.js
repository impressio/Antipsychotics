/* =====================================================================
 * routes.js - Interactive administration routes web table & comparator
 *
 * The selected route lives in ONE place (the PK simulator's #pk-route).
 * Clicking a bar/row here calls window.syncRouteSelection(), and every
 * change of route or drug elsewhere calls Routes.reflect() so this section
 * always mirrors the current state.
 * ===================================================================== */
window.Routes = (function () {
  'use strict';

  let notice = null; // { key: 'route|drug', text }

  function init() { renderRoutesSection(); }

  /** Onset times span minutes (IV) to weeks (depot), so bars are scaled logarithmically */
  const barWidth = (minutes, max) => {
    const lg = (x) => Math.log10(Math.max(1, x));
    return Math.max(8, Math.min(100, (lg(minutes) / lg(max)) * 100));
  };

  /** English route data (AP.raw) for parsing; displayed text may be translated */
  const rawRoute = (id) => (AP.raw.routes || []).find(r => r.id === id) || {};
  const rawDrugRoute = (drugKey, id) => (drugKey && AP.raw.drugRoutes && AP.raw.drugRoutes[drugKey] ? AP.raw.drugRoutes[drugKey][id] : null);

  function renderRoutesSection() {
    const host = document.getElementById('routes-container');
    if (!host) return;
    const routes = AP.routes || [];
    const max = Math.max(...routes.map(r => r.onsetMin));

    host.innerHTML = `
      <div class="routes-overview">
        <div class="card routes-visualizer">
          <h3>${AP.t('rt.bars.title')}</h3>
          <p class="muted">${AP.t('rt.bars.intro')}</p>
          <div class="route-bars" id="route-bars">
            ${[...routes].sort((a, b) => a.onsetMin - b.onsetMin).map(r => `
              <div class="route-bar-row" data-route-id="${r.id}">
                <div class="route-bar-label">
                  <b>${r.name.split('(')[0].trim()}</b>
                  <span class="route-bar-tag" style="background:${r.badgeColor}">${r.onset}</span>
                </div>
                <div class="route-bar-track">
                  <div class="route-bar-fill" style="width:${barWidth(r.onsetMin, max)}%; background:${r.badgeColor}"></div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="card route-detail-card" id="route-detail-card"></div>
      </div>

      <div class="card">
        <h3>${AP.t('rt.table.title')}</h3>
        <p class="muted">${AP.t('rt.table.intro')}</p>
        <div class="table-responsive">
          <table class="web-table">
            <thead>
              <tr>
                <th>${AP.t('rt.th.route')}</th>
                <th>${AP.t('rt.th.onset')}</th>
                <th>${AP.t('rt.th.tmax')}</th>
                <th>${AP.t('rt.th.f')}</th>
                <th>${AP.t('rt.th.drugs')}</th>
                <th>${AP.t('rt.th.ind')}</th>
                <th>${AP.t('rt.th.advlim')}</th>
              </tr>
            </thead>
            <tbody id="routes-tbody">
              ${routes.map(r => `
                <tr data-route-id="${r.id}">
                  <td><b style="color:${r.badgeColor}">${r.name}</b></td>
                  <td>${r.onset}</td>
                  <td>${r.tmax}</td>
                  <td>${r.bioavailability}</td>
                  <td>${r.commonDrugs}</td>
                  <td>${r.primaryIndications}</td>
                  <td>
                    <span class="adv">✓ ${r.advantages}</span><br/>
                    <span class="lim">⚠ ${r.limitations}</span>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    host.querySelectorAll('.route-bar-row, table.web-table tbody tr').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-route-id');
        if (!id) return;
        if (window.syncRouteSelection) window.syncRouteSelection(id, 'routes');
        else reflect(id, null);
      });
    });
  }

  function drugsForRoute(routeId) {
    return Object.entries(AP.drugs)
      .filter(([, d]) => d.pk && (d.routes || ['oral']).includes(routeId))
      .map(([k, d]) => ({ key: k, name: d.name, color: d.color }));
  }

  /** Chip color for a speed category (fast = warm, slow = neutral); parses the English original */
  function speedColor(speed) {
    if (/^Very rapid/.test(speed)) return '#c92a2a';
    if (/^Rapid/.test(speed)) return '#e8590c';
    if (/^Standard|^Intermediate|^Slow/.test(speed)) return '#1971c2';
    if (/^Depot/.test(speed)) return '#2b8a3e';
    return '#868e96';
  }

  /** Mirror the current route / drug in every element of this section */
  function reflect(routeId, drugKey) {
    const host = document.getElementById('routes-container');
    if (!host || !routeId) return;
    const drug = drugKey ? AP.drugs[drugKey] : null;
    const allowed = drug ? (drug.routes || ['oral']) : null;

    host.querySelectorAll('.route-bar-row, table.web-table tbody tr').forEach(el => {
      const id = el.getAttribute('data-route-id');
      el.classList.toggle('selected', id === routeId);
      const unavailable = !!(allowed && !allowed.includes(id));
      el.classList.toggle('unavailable', unavailable);
      el.title = unavailable ? AP.t('rt.notFormulatedTip', { drug: drug.name }) : '';
    });

    updateBars(drugKey, allowed);
    showRouteDetail(routeId, drugKey);
  }

  /** Midpoint (minutes) of an English onset string such as '15-30 min', '1-3 h' or 'Days' */
  function onsetMid(text) {
    const unit = /week/i.test(text) ? 10080 : /day/i.test(text) ? 1440 : /\bh\b|hour/i.test(text) ? 60 : 1;
    const m = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/.exec(text) || /(\d+(?:\.\d+)?)/.exec(text);
    if (!m) return /week/i.test(text) ? 10080 : /day/i.test(text) ? 2880 : null;
    return (m[2] ? (+m[1] + +m[2]) / 2 : +m[1]) * unit;
  }

  /** Onset bars: drug-specific values where the drug is formulated, route-level range otherwise */
  function updateBars(drugKey, allowed) {
    const routes = AP.routes || [];
    const dRoutes = drugKey && AP.drugRoutes ? AP.drugRoutes[drugKey] || {} : {};
    const vals = routes.map(r => {
      const dr = allowed && allowed.includes(r.id) ? dRoutes[r.id] : null;
      if (!dr) return { id: r.id, label: r.onset, min: r.onsetMin };
      const mid = onsetMid((rawDrugRoute(drugKey, r.id) || dr).onset);
      return { id: r.id, label: dr.onset.replace(/ \(.*\)$/, ''), min: mid !== null ? mid : r.onsetMin };
    });
    const max = Math.max(...vals.map(v => v.min));
    const box = document.getElementById('route-bars');
    if (!box) return;
    vals.sort((a, b) => a.min - b.min).forEach(v => {
      const row = box.querySelector(`.route-bar-row[data-route-id="${v.id}"]`);
      if (!row) return;
      row.querySelector('.route-bar-tag').textContent = v.label;
      row.querySelector('.route-bar-fill').style.width = `${barWidth(v.min, max)}%`;
      box.appendChild(row);
    });
  }

  function setNotice(routeId, drugKey, text) {
    notice = text ? { key: `${routeId}|${drugKey}`, text } : null;
  }

  /** Interval in hours as text ("12 h", "28 days") */
  const interval = (h) => (h >= 48 ? AP.t('rt.days', { n: AP.fmt(h / 24) }) : AP.t('rt.hours', { n: AP.fmt(h) }));

  function showRouteDetail(routeId, drugKey) {
    const card = document.getElementById('route-detail-card');
    if (!card) return;
    const route = (AP.routes || []).find(r => r.id === routeId);
    if (!route) return;

    const drug = drugKey ? AP.drugs[drugKey] : null;
    const chips = drugsForRoute(routeId).map(d => `
      <button type="button" class="route-drug-chip ${d.key === drugKey ? 'active' : ''}" data-drug-key="${d.key}"
        style="--chip:${d.color}">${d.name}</button>`).join('');
    const showNotice = notice && notice.key === `${routeId}|${drugKey}` ? notice.text : '';

    // Bioavailability of the selected drug by this route, as used by the pharmacokinetic model
    const mods = [...document.querySelectorAll('#pk-mods input:checked')].map(cb => cb.value);
    const formulated = drug && drug.pk && window.PK && window.PK.getAllowedRoutes
      ? window.PK.getAllowedRoutes(drug).includes(routeId) : false;
    const F = formulated ? Models.bioavailability(drug, routeId, mods) : null;
    const fValue = !drug ? AP.t('rt.f.noDrug')
      : !drug.pk ? AP.t('rt.f.noPk')
        : !formulated ? AP.t('rt.f.notFormulated')
          : `${AP.fmt(F * 100)} %`;
    const fNote = drug && formulated && mods.length ? AP.t('rt.withMods') : '';

    // Elimination half-life: a drug property (route-independent); for depots the apparent half-life
    // is absorption-limited (flip-flop kinetics), so the absorption half-life is shown as well
    const row = drug ? (AP.substancesTable || []).find(t => t.key === drugKey) : null;
    const rawRow = drug ? (AP.raw.substances || []).find(t => t.key === drugKey) : null;
    const tHalf = row ? row.tHalf : (drug && drug.pk ? AP.t('rt.hoursApprox', { n: AP.fmt(drug.pk.t12) }) : '-');
    const abs = formulated && drug.pk.rt && drug.pk.rt[routeId] ? Models.routeAbsorption(drug, routeId, Models.effectivePK(drug, [], 70)) : null;
    const tAbs = abs && abs.tAbs ? abs.tAbs : null;   // depots: release half-life of the selected product
    const tHalfNote = tAbs && tAbs > drug.pk.t12 && abs.releaseEnd < tAbs
      ? AP.t('rt.absLimited', { days: AP.fmt(tAbs / 24) })
      : (rawRow && /^Active/.test(rawRow.metabolites) ? row.metabolites : '');

    const dr = formulated && AP.drugRoutes && AP.drugRoutes[drugKey] ? AP.drugRoutes[drugKey][routeId] : null;
    const rawDr = formulated ? rawDrugRoute(drugKey, routeId) : null;
    const genericKey = route.onsetMin <= 30 ? 'rapid' : route.onsetMin <= 1440 ? 'standard' : 'depot';
    const info = dr
      ? { speed: dr.speed, color: speedColor((rawDr || dr).speed), onset: dr.onset, tmax: dr.tmax, ind: dr.ind, adv: dr.adv, caut: dr.caut, note: '' }
      : { speed: AP.t(`rt.speed.${genericKey}`), color: speedColor({ rapid: 'Rapid', standard: 'Standard', depot: 'Depot' }[genericKey]),
        onset: route.onset, tmax: route.tmax, ind: route.primaryIndications, adv: route.advantages, caut: route.limitations, note: AP.t('rt.allDrugs') };
    const reg = formulated ? Models.regimenFor(drug, routeId) : null;

    card.innerHTML = `
      <p class="route-chips-label"><b>${AP.t('rt.formulated')}</b></p>
      <div class="route-drug-chips">${chips || `<span class="muted">${AP.t('rt.noDrug')}</span>`}</div>
      <h3>${drug && formulated ? `${drug.name} · ${route.name}` : AP.t('rt.pharmacology', { route: route.name })}</h3>

      ${showNotice ? `<div class="route-notice">${showNotice}</div>` : ''}

      <div class="readouts route-readouts">
        <div class="readout route-metric">
          <div class="k">${AP.t('rt.k.f')}</div>
          <div class="v" style="color:${route.badgeColor}">${fValue}</div>
          ${fNote ? `<div class="route-metric-note">${fNote}</div>` : ''}
        </div>
        <div class="readout route-metric">
          <div class="k">${AP.t('rt.k.onset')}</div>
          <div class="v">${info.onset}</div>
        </div>
        <div class="readout route-metric">
          <div class="k">${AP.t('rt.k.tmax')}</div>
          <div class="v">${info.tmax}</div>
        </div>
        <div class="readout route-metric">
          <div class="k">${AP.t('rt.k.t12')}</div>
          <div class="v">${tHalf}</div>
          ${tHalfNote ? `<div class="route-metric-note">${tHalfNote}</div>` : ''}
        </div>
      </div>

      <p class="route-speed"><b>${AP.t('rt.speedCat')}</b>
        <span class="route-speed-chip" style="--chip:${info.color}">${info.speed}</span>
        ${reg && reg.label ? `<span class="route-metric-note">${AP.t('rt.regimen', { dose: AP.fmtAuto(reg.dose), interval: interval(reg.tau), label: reg.label })}</span>` : ''}
        ${info.note ? `<span class="route-metric-note">${info.note}</span>` : ''}
      </p>

      <p><b>${AP.t('rt.ind')}</b> ${info.ind}</p>
      <div class="route-box adv"><b>${AP.t('rt.adv')}</b> ${info.adv}</div>
      <div class="route-box caut"><b>${AP.t('rt.caut')}</b> ${info.caut}</div>
    `;

    card.querySelectorAll('.route-drug-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.getAttribute('data-drug-key');
        if (k && window.syncDrugSelection) window.syncDrugSelection(k, 'routes');
      });
    });
  }

  return { init, reflect, setNotice, showRouteDetail };
})();
