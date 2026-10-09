/* =====================================================================
 * receptor.js - Mechanism controls, D2 receptor model state & readouts
 * (the rotatable receptor structure itself is drawn by structure.js)
 *
 * Readouts are quantitative only: site occupancy by drug and dopamine,
 * functional D2 blockade and relative Gi signaling. Descriptive text for
 * targets and pathways comes from js/data.js.
 * ===================================================================== */
window.Receptor = (function () {
  'use strict';

  const COLORS = { receptor: '#3B6FD8', da: '#E67700', gi: '#0B7285' };

  /** Who occupies the orthosteric site: the selected drug, dopamine, or nobody */
  function siteOccupant(state) {
    const { d2, drug } = state;
    const drugIn = !!(drug && d2.occD > 0.05);
    const daIn = d2.occDA > 0.05;
    if (drugIn) return { kind: 'drug', drug, color: drug.color, name: drug.name };
    if (daIn) return { kind: 'dopamine', drug: null, color: COLORS.da, name: AP.dopamine.name };
    return { kind: null, drug: null, color: '#ced4da', name: '' };
  }

  let currentInfo = 'pathway';

  function init() {
    if (!document.getElementById('m-readouts')) return;
    populateControls();

    document.getElementById('m-da')?.addEventListener('change', update);
    const pathSel = document.getElementById('m-path');
    pathSel?.addEventListener('change', () => {
      if (window.syncPathwaySelection) { window.syncPathwaySelection(pathSel.value, 'm-path'); return; }
      const p = AP.pathways[pathSel.value];
      const daSel = document.getElementById('m-da');
      if (p && daSel) daSel.value = String(p.da);
      currentInfo = 'pathway';
      update();
    });

    const ligSel = document.getElementById('m-ligand');
    ligSel?.addEventListener('change', () => {
      if (window.syncDrugSelection) window.syncDrugSelection(ligSel.value, 'm-ligand');
      else update();
    });

    const concEl = document.getElementById('m-conc');
    concEl?.addEventListener('input', () => {
      doseMode = false;
      updateDoseNote();
      updateConcDisplay();
      update();
      // keep the Pharmacodynamics free-concentration slider (same log scale) in step
      const pdConc = document.getElementById('pd-conc');
      if (pdConc && pdConc.value !== concEl.value) {
        pdConc.value = concEl.value;
        if (window.PD && window.PD.syncConc) window.PD.syncConc();
      }
    });

    ['m-dose', 'm-n', 'm-tau'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', () => { doseMode = true; pushDosingToPK(true); applyDose(); update(); });
    });

    updateConcDisplay();
    update();
  }

  function populateControls() {
    const pathSel = document.getElementById('m-path');
    if (pathSel && pathSel.options.length === 0) {
      Object.entries(AP.pathways).forEach(([k, p]) => {
        pathSel.appendChild(Object.assign(document.createElement('option'), { value: k, textContent: `${p.label} · ${p.route}` }));
      });
      pathSel.value = 'mesolimbic';
    }
    const ligSel = document.getElementById('m-ligand');
    if (ligSel && ligSel.options.length === 0) {
      ligSel.appendChild(Object.assign(document.createElement('option'), { value: 'none', textContent: AP.t('mechanism.noDrug') }));
      Object.entries(AP.drugs).forEach(([k, v]) => {
        const opt = Object.assign(document.createElement('option'), { value: k, textContent: `${v.name} (${v.role})` });
        if (k === 'risperidone') opt.selected = true;
        ligSel.appendChild(opt);
      });
    }
  }

  /**
   * Dose → free concentration: peak plasma concentration of the D2-active moiety over the
   * regimen (one-compartment model, route selected in Pharmacokinetics), converted to a free
   * concentration in K_i units calibrated to PET D2 occupancy (Models.freeFromPlasma).
   */
  let doseMode = true;
  let lastLigand = null;
  let doseInfo = null;

  function setDefaultDose() {
    const drug = AP.drugs[document.getElementById('m-ligand')?.value || 'none'];
    const ok = !!(drug && drug.pk);
    ['m-dose', 'm-n', 'm-tau'].forEach(id => { const e = document.getElementById(id); if (e) e.disabled = !ok; });
    if (ok) {
      const reg = Models.regimenFor(drug, regimen().route);
      document.getElementById('m-dose').value = reg.dose;
      document.getElementById('m-tau').value = reg.tau;
      pushDosingToPK(false);
    }
    doseMode = ok;
  }

  /** Copy the section 1 dosing regimen into the Pharmacokinetics inputs (optionally re-plotting PK) */
  function pushDosingToPK(replot) {
    let changed = false;
    [['m-dose', 'pk-dose'], ['m-n', 'pk-n'], ['m-tau', 'pk-tau']].forEach(([a, b]) => {
      const src = document.getElementById(a), dst = document.getElementById(b);
      if (src && dst && dst.value !== src.value) { dst.value = src.value; changed = true; }
    });
    if (replot && changed && window.PK && window.PK.update) window.PK.update();
  }

  /** Regimen + patient settings that determine the derived concentration */
  function regimen() {
    const key = document.getElementById('m-ligand')?.value || 'none';
    const drug = AP.drugs[key];
    const num = (id, d) => { const v = parseFloat(document.getElementById(id)?.value); return Number.isFinite(v) ? v : d; };
    const allowed = drug && window.PK && window.PK.getAllowedRoutes ? window.PK.getAllowedRoutes(drug) : null;
    const pkRoute = document.getElementById('pk-route')?.value;
    const route = drug ? ((allowed && allowed.includes(pkRoute)) ? pkRoute : (drug.defaultRoute || 'oral')) : 'oral';
    const mods = [...document.querySelectorAll('#pk-mods input:checked')].map(cb => cb.value);
    return { key, drug, dose: num('m-dose', 0), n: Math.max(1, Math.round(num('m-n', 1))), tau: Math.max(1, num('m-tau', 24)), route, weight: num('pk-wt', 70), mods };
  }
  let lastSig = '';
  const sigOf = (r) => JSON.stringify([r.key, r.dose, r.n, r.tau, r.route, r.weight, r.mods, r.drug ? (Models.routeProduct(r.drug, r.route) || {}).key : '']);

  /** Called by the PK section after it updates: mirror its dosing inputs and re-derive the concentration */
  function syncFromPK() {
    [['pk-dose', 'm-dose'], ['pk-n', 'm-n'], ['pk-tau', 'm-tau']].forEach(([a, b]) => {
      const src = document.getElementById(a), dst = document.getElementById(b);
      if (src && dst && dst.value !== src.value) dst.value = src.value;
    });
    if (sigOf(regimen()) === lastSig) return;
    doseMode = true;
    applyDose();
    update();
  }

  function applyDose() {
    const drug = AP.drugs[document.getElementById('m-ligand')?.value || 'none'];
    const concEl = document.getElementById('m-conc');
    doseInfo = null;
    if (!doseMode || !drug || !drug.pk || !concEl) { updateDoseNote(); return; }
    const r = regimen();
    lastSig = sigOf(r);
    if (!(r.dose > 0)) { updateDoseNote(); return; }
    const sim = Models.simulate({ drug, dose: r.dose, route: r.route, n: r.n, tau: r.tau, weight: r.weight, mods: r.mods });
    const cp = sim.params.moietyMax;
    const free = Models.freeFromPlasma(drug, cp);
    doseInfo = { ...r, cp, free };
    concEl.value = Math.max(-2, Math.min(4, Math.log10(Math.max(free, 1e-3)))).toFixed(2);
    updateConcDisplay();
    updateDoseNote();
    const pdConc = document.getElementById('pd-conc');
    if (pdConc && pdConc.value !== concEl.value) {
      pdConc.value = concEl.value;
      if (window.PD && window.PD.syncConc) window.PD.syncConc();
    }
  }

  function updateDoseNote() {
    const note = document.getElementById('m-dose-note');
    if (!note) return;
    const drug = AP.drugs[document.getElementById('m-ligand')?.value || 'none'];
    if (!drug) { note.textContent = AP.t('mechanism.doseNoDrug'); return; }
    if (!doseMode || !doseInfo) { note.textContent = AP.t('mechanism.doseManual'); return; }
    const di = doseInfo;
    const moiety = (drug.pk.metabolites || []).some(m => m.d2);
    const regimen = di.n > 1 ? AP.t('mechanism.doseRegimen', { n: di.n, tau: AP.fmt(di.tau) }) : '';
    note.textContent = AP.t(!drug.pd.ec50 ? 'mechanism.doseNoteUnbound' : moiety ? 'mechanism.doseNoteMoiety' : 'mechanism.doseNote', {
      cp: AP.fmtAuto(AP.conc(di.cp, drug.mw)), unit: AP.concUnit(), regimen, free: fmtConc(di.free) });
  }

  const getConcNM = () => Math.pow(10, parseFloat(document.getElementById('m-conc')?.value ?? 1));

  function fmtConc(nM) {
    if (nM < 0.1) return `${AP.fmt(nM * 1000)} pM`;
    if (nM < 1000) return `${AP.fmt(nM, nM < 1 ? 2 : nM < 10 ? 1 : 0)} nM`;
    return `${AP.fmt(nM / 1000, 2)} µM`;
  }

  function updateConcDisplay() {
    const lbl = document.getElementById('m-conc-val');
    if (lbl) lbl.textContent = fmtConc(getConcNM());
  }

  function getState() {
    const da = parseFloat(document.getElementById('m-da')?.value ?? '200');
    const ligandKey = document.getElementById('m-ligand')?.value || 'risperidone';
    const pathKey = document.getElementById('m-path')?.value || 'mesolimbic';
    const cNM = ligandKey === 'none' ? 0 : getConcNM();
    const d2 = Models.d2Site(ligandKey, cNM, da);
    const drug = ligandKey !== 'none' ? AP.drugs[ligandKey] : null;
    return { da, ligandKey, pathKey, cNM, d2, drug, path: AP.pathways[pathKey], blockade: drug ? Models.blockade(ligandKey, d2.occD) : 0 };
  }

  function update() {
    const ligNow = document.getElementById('m-ligand')?.value || 'none';
    if (ligNow !== lastLigand) {
      lastLigand = ligNow;
      setDefaultDose();
      applyDose();
    }
    const state = getState();
    renderHeader(state);
    renderReadouts(state);
    if (window.Structure && typeof window.Structure.setState === 'function') window.Structure.setState(state);
    showInfo(currentInfo);
  }

  /** Signaling state for the header badge (relative to dopamine alone) */
  function signalParams(state) {
    const { d2, drug } = state;
    const rel = d2.base > 0 ? d2.signal / d2.base : (d2.signal > 0.01 ? Infinity : 1);
    let label;
    if (d2.signal < 0.03) label = AP.t(drug && d2.occD > 0.05 ? 'rx.inactiveAntagonist' : 'rx.inactiveNoAgonist');
    else if (rel > 1.1 || rel < 0.9) label = AP.t('rx.signalRel', { pct: AP.fmt(rel * 100) });
    else label = AP.t('rx.activeDopamine');
    return { occ: siteOccupant(state), rel, label, active: d2.signal >= 0.03 };
  }

  function renderHeader(state) {
    const title = document.getElementById('rx-title');
    const badge = document.getElementById('rx-badge');
    const sp = signalParams(state);
    if (title) {
      const parts = [];
      if (state.da > 0) parts.push(AP.dopamine.name);
      if (state.drug && state.d2.occD > 0.05) parts.push(state.drug.name);
      title.textContent = parts.length ? parts.join(' & ') : AP.t('rx.noLigands');
    }
    if (badge) {
      badge.textContent = sp.label;
      badge.style.background = !sp.active ? '#c92a2a' : (sp.rel < 0.9 ? '#e8590c' : '#2b8a3e');
      badge.classList.toggle('pulse-open', sp.active && sp.rel >= 0.9);
    }
  }

  /** Info panel: interface texts (rx.info.*) and descriptions from properties.json (pathway, target, ligand) */
  function showInfo(type) {
    const box = document.getElementById('m-subinfo');
    if (!box) return;
    currentInfo = type;
    box.innerHTML = infoHtml(type, getState());
  }

  /** HTML of the info panel for a topic and state (also used to measure the tallest panel) */
  function infoHtml(type, state) {
    const p = state.path;
    const d2 = AP.targets.d2;
    if (type === 'pocket') {
      return `
        <h4 class="info-drug">${AP.t('rx.info.pocketTitle')}</h4>
        <p>${AP.t('rx.info.pocketLocation')}</p>
        <p>${AP.t('rx.info.pocketResidues')}</p>
        <p>${AP.t('rx.info.pocketTemplate')}</p>`;
    } else if (type === 'dopamine') {
      return `
        <h4 style="color:${COLORS.da}">${AP.dopamine.name}</h4>
        <p>${AP.dopamine.use}</p>
        <p>${AP.t('rx.info.daConstants', { k: AP.fmt(AP.DA.K), tonic: AP.fmt(AP.DA.TONIC) })}</p>
        <p>${AP.t('rx.info.daPose')}</p>`;
    } else if (type === 'gi') {
      return `
        <h4 style="color:${COLORS.gi}">${AP.t('rx.info.giTitle')}</h4>
        <p>${AP.t('rx.info.giText')}</p>
        <p>${AP.t('rx.info.giMorph')}</p>`;
    } else {
      return `
        <h4 style="color:${COLORS.receptor}">${AP.t('rx.info.pathwayTitle', { pathway: p.label })}</h4>
        <p>${AP.t('rx.info.projection', { route: p.route })}</p>
        <p>${p.role}</p>
        <p>${AP.t('rx.info.pathwayDa', { da: AP.fmt(p.da) })}</p>
        <p class="muted">${AP.t('rx.info.d2Distribution', { location: d2.location })}</p>`;
    }
  }

  function renderReadouts(state) {
    const container = document.getElementById('m-readouts');
    if (!container) return;
    const { d2, drug, blockade } = state;
    const rel = d2.base > 0 ? d2.signal / d2.base : null;
    const pct = (x) => `${AP.fmt(x * 100, 1)} %`;
    const iaVal = drug ? Models.ia(drug, 'd2') : 0;

    container.innerHTML = `
      <div class="readout">
        <div class="k">${AP.t('mechanism.occD2')}</div>
        <div class="v" style="color:${drug ? drug.color : '#868e96'}">${pct(drug ? d2.occD : 0)}</div>
        <div class="v small">${AP.t('mechanism.occDA', { pct: pct(d2.occDA) })}</div>
      </div>

      <div class="readout">
        <div class="k">${AP.t('mechanism.blockade')}</div>
        <div class="v" style="color:#5f3dc4">${pct(blockade)}</div>
        <div class="v small">${iaVal > 0 ? AP.t('mechanism.partialAgonist', { ia: AP.fmt(iaVal, 2) }) : AP.t('mechanism.antagonist')}</div>
      </div>

      <div class="readout full">
        <div class="k">${AP.t('mechanism.signaling')}</div>
        <div class="v" style="color:${COLORS.gi}">${pct(d2.signal)}</div>
        <div class="bar"><i style="width:${Math.min(100, d2.signal * 100)}%"></i></div>
        <div class="v small">${rel === null ? AP.t('mechanism.noDopamine') : AP.t('mechanism.relDopamine', { pct: AP.fmt(rel * 100), base: pct(d2.base) })}</div>
      </div>
    `;
  }

  /** Called when the Pharmacodynamics slider moves: mirror its value here */
  function syncConc() { updateConcDisplay(); update(); }

  /** State for a drug, pathway and free concentration without reading the controls (for measuring) */
  function stateFor(ligandKey, pathKey, cNM) {
    const path = AP.pathways[pathKey], da = path.da;
    const d2 = Models.d2Site(ligandKey, cNM, da);
    const drug = ligandKey !== 'none' ? AP.drugs[ligandKey] : null;
    return { da, ligandKey, pathKey, cNM, d2, drug, path, blockade: drug ? Models.blockade(ligandKey, d2.occD) : 0 };
  }

  return { init, update, showInfo, infoHtml, stateFor, getState, signalParams, siteOccupant, syncConc, syncFromPK };
})();
