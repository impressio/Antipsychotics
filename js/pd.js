/* =====================================================================
 * pd.js - Pharmacodynamics (receptor occupancy by target, dopamine
 * competition, affinity profile, dose-occupancy relationship) and the
 * target cards of section 2. Powered by Plotly.js
 * ===================================================================== */
window.PD = (function () {
  'use strict';

  const targets = () => AP.regions.order;   // display order of the receptor targets

  function waitForPlotly(cb, maxRetries = 60) {
    if (typeof Plotly !== 'undefined') { cb(); return; }
    let count = 0;
    const interval = setInterval(() => {
      count++;
      if (typeof Plotly !== 'undefined') { clearInterval(interval); cb(); }
      else if (count >= maxRetries) { clearInterval(interval); console.warn('Plotly library took too long to load.'); }
    }, 100);
  }

  function init() {
    populateControls();
    attachListeners();
    waitForPlotly(update);
  }

  function populateControls() {
    const drugSel = document.getElementById('pd-drug');
    if (drugSel && drugSel.options.length === 0) {
      drugSel.appendChild(Object.assign(document.createElement('option'), { value: 'none', textContent: AP.t('pd.noDrugOption') }));
      Object.entries(AP.drugs).forEach(([k, v]) => {
        const opt = Object.assign(document.createElement('option'), { value: k, textContent: `${v.name} (${v.role})` });
        if (k === 'risperidone') opt.selected = true;
        drugSel.appendChild(opt);
      });
    }
    const daSel = document.getElementById('pd-da');
    if (daSel && daSel.options.length === 0) {
      Object.values(AP.pathways).forEach(p => {
        daSel.appendChild(Object.assign(document.createElement('option'), { value: String(p.da), textContent: AP.t('pd.daOption', { pathway: p.label, da: AP.fmt(p.da) }) }));
      });
      daSel.value = String(AP.pathways.mesolimbic.da);
    }
  }

  function attachListeners() {
    document.getElementById('pd-da')?.addEventListener('change', update);

    const drugSel = document.getElementById('pd-drug');
    drugSel?.addEventListener('change', () => {
      if (window.syncDrugSelection) window.syncDrugSelection(drugSel.value, 'pd-drug');
      else update();
    });

    const conc = document.getElementById('pd-conc');
    conc?.addEventListener('input', () => {
      updateLabels();
      update();
      const mConc = document.getElementById('m-conc');
      if (mConc && mConc.value !== conc.value) {
        mConc.value = conc.value;
        if (window.Receptor && window.Receptor.syncConc) window.Receptor.syncConc();
      }
    });
    updateLabels();
  }

  const getConcNM = () => Math.pow(10, parseFloat(document.getElementById('pd-conc')?.value ?? 1));
  const getDaNM = () => parseFloat(document.getElementById('pd-da')?.value ?? String(AP.DA.TONIC));

  function fmtConc(nM) {
    if (nM < 0.1) return `${AP.fmt(nM * 1000)} pM`;
    if (nM < 1000) return `${AP.fmt(nM, nM < 1 ? 2 : nM < 10 ? 1 : 0)} nM`;
    return `${AP.fmt(nM / 1000, 2)} µM`;
  }
  const pct = (x, d = 0) => `${AP.fmt(x, d)} %`;
  const plotBase = () => ({
    font: AP.plotFont(), hoverlabel: AP.plotHover(), separators: AP.plotSeparators(),
    plot_bgcolor: '#ffffff', paper_bgcolor: '#ffffff',
  });
  const legendBelow = { showlegend: true, legend: { orientation: 'h', yanchor: 'top', y: -0.34, x: 0 } };

  function updateLabels() {
    const el = document.getElementById('pd-conc-val');
    if (el) el.textContent = fmtConc(getConcNM());
  }

  function update() {
    if (typeof Plotly === 'undefined') { waitForPlotly(update); return; }
    const drugKey = document.getElementById('pd-drug')?.value || 'risperidone';
    const cNM = drugKey === 'none' ? 0 : getConcNM();
    const daNM = getDaNM();

    plotTargetOccupancy(drugKey, cNM, daNM);
    plotDopamineCompetition(drugKey, cNM, daNM);
    plotAffinityProfile(drugKey);
    plotDoseOccupancy(drugKey);
    renderTargetCards(drugKey, cNM, daNM);
  }

  /** Plot A: occupancy-concentration curves across all modeled targets */
  function plotTargetOccupancy(drugKey, curConc, daNM) {
    const target = document.getElementById('pd-plot-occ');
    if (!target) return;
    const conc = [];
    for (let lg = -2; lg <= 4; lg += 0.04) conc.push(Math.pow(10, lg));
    const d = drugKey !== 'none' ? AP.drugs[drugKey] : null;

    const traces = targets().filter(t => !d || d.pd.ki[t] < AP.NB).map(t => ({
      x: conc, y: conc.map(c => Models.occupancy(drugKey, t, c, daNM) * 100),
      type: 'scatter', mode: 'lines', name: AP.targets[t].label,
      line: { color: AP.targets[t].color, width: t === 'd2' ? 3.5 : 2 },
    }));
    traces.push({
      x: [curConc, curConc], y: [0, 100], type: 'scatter', mode: 'lines',
      name: AP.t('pd.selected', { conc: fmtConc(curConc) }), line: { color: '#c92a2a', width: 2, dash: 'dash' },
    });

    Plotly.react(target, traces, {
      ...plotBase(), ...legendBelow,
      xaxis: { type: 'log', title: { text: AP.t('pd.axisFreeConc'), standoff: 8 }, automargin: true, gridcolor: '#f1f3f5' },
      yaxis: { title: { text: AP.t('pd.axisOccupancy') }, range: [0, 105], gridcolor: '#f1f3f5' },
      margin: { l: 55, r: 20, t: 25, b: 115 },
    }, { responsive: true, displayModeBar: false });

    const summary = document.getElementById('pd-occ-summary');
    if (!summary) return;
    if (!d) { summary.innerHTML = AP.t('pd.occNoDrug'); return; }
    const occNow = targets().map(t => ({ t, occ: Models.occupancy(drugKey, t, curConc, daNM) * 100 }))
      .filter(e => e.occ >= 1).sort((a, b) => b.occ - a.occ);
    summary.innerHTML = AP.t('pd.occSummary', {
      conc: fmtConc(curConc), da: AP.fmt(daNM),
      list: occNow.length ? occNow.map(e => `${AP.targets[e.t].label} ${pct(e.occ)}`).join(', ') : AP.t('pd.noOccupancy'),
    });
  }

  /** Plot B: how synaptic dopamine shifts D2 signaling (competitive antagonism / partial agonism) */
  function plotDopamineCompetition(drugKey, curConc, curDa) {
    const target = document.getElementById('pd-plot-cr');
    if (!target) return;
    const da = [];
    for (let lg = 0; lg <= 3.5; lg += 0.02) da.push(Math.pow(10, lg));
    const d = drugKey !== 'none' ? AP.drugs[drugKey] : null;

    const sig = (c) => da.map(a => Models.d2Site(drugKey, c, a).signal * 100);
    const traces = [
      { x: da, y: da.map(a => Models.d2Site('none', 0, a).signal * 100), type: 'scatter', mode: 'lines', name: AP.t('pd.daAlone'), line: { color: '#868e96', width: 2.5, dash: 'dash' } },
    ];
    if (d && !(d.pd.ki.d2 >= AP.NB)) {   // no D2 binding: the drug curves would coincide with dopamine alone
      [[0.3, 'dot'], [1, 'solid'], [3, 'dashdot']].forEach(([f, dash]) => {
        traces.push({
          x: da, y: sig(curConc * f), type: 'scatter', mode: 'lines',
          name: f === 1 ? AP.t('pd.plusDrug', { drug: d.name, conc: fmtConc(curConc) }) : AP.t('pd.plusDrugFold', { drug: d.name, f: AP.fmt(f, f < 1 ? 1 : 0), conc: fmtConc(curConc * f) }),
          line: { color: d.color, width: f === 1 ? 3.5 : 1.8, dash },
        });
      });
    }
    traces.push({ x: [curDa, curDa], y: [0, 100], type: 'scatter', mode: 'lines', name: AP.t('pd.synapticDa', { da: AP.fmt(curDa) }), line: { color: '#c92a2a', width: 2, dash: 'dash' } });

    Plotly.react(target, traces, {
      ...plotBase(), ...legendBelow,
      xaxis: { type: 'log', title: { text: AP.t('pd.axisDa'), standoff: 8 }, automargin: true, gridcolor: '#f1f3f5' },
      yaxis: { title: { text: AP.t('pd.axisSignal') }, range: [0, 105], gridcolor: '#f1f3f5' },
      margin: { l: 55, r: 20, t: 25, b: 115 },
    }, { responsive: true, displayModeBar: false });

    const summary = document.getElementById('pd-cr-summary');
    if (!summary) return;
    if (!d) { summary.innerHTML = AP.t('pd.crNoDrug'); return; }
    if (d.pd.ki.d2 >= AP.NB) { summary.innerHTML = AP.t('pd.crNoD2', { drug: d.name }); return; }
    const iaD2 = Models.ia(d, 'd2');
    const st = Models.d2Site(drugKey, curConc, curDa);
    const vars = { drug: d.name, ia: AP.fmt(iaD2, 2), iaPct: AP.fmt(iaD2 * 100), signal: pct(st.signal * 100), base: pct(st.base * 100) };
    summary.innerHTML = AP.t(iaD2 > 0 ? 'pd.crPartial' : 'pd.crAntagonist', vars);
  }

  /** Plot C: affinity profile across targets (radar of pKi) */
  function plotAffinityProfile(drugKey) {
    const target = document.getElementById('pd-plot-sel');
    if (!target) return;
    const d = drugKey !== 'none' ? AP.drugs[drugKey] : null;
    const T = targets();
    const labels = T.map(t => AP.targets[t].label);
    const FLOOR = 5.0;
    const close = (a) => [...a, a[0]];
    // One layer per compound: the drug, then co-formulated compounds (e.g. trospium in xanomeline-trospium)
    const comps = d ? (d.pd.components || []) : [];
    // Not determined (no human Kᵢ found): plotted at the floor with a hollow marker
    const layer = (ki, color, name, dash, nd = []) => {
      const prof = T.map(t => { const k = ki ? (ki[t] ?? AP.NB) : AP.NB; return k < AP.NB ? 9 - Math.log10(k) : null; });
      return {
        type: 'scatterpolar', r: close(prof.map(p => (p === null ? FLOOR : Math.max(FLOOR, +p.toFixed(2))))), theta: close(labels),
        fill: 'toself', fillcolor: `${color}26`, line: { color, width: 2.5, dash }, name,
        marker: { size: 6, color, symbol: close(T.map(t => (nd.includes(t) ? 'circle-open' : 'circle'))) },
        text: close(prof.map((p, i) => (nd.includes(T[i]) ? AP.t('pd.notDetermined') : p === null ? AP.t('pd.notBoundKi') : `pKᵢ ${AP.fmt(p, 2)}`))), hoverinfo: 'theta+text+name',
      };
    };

    const traces = [
      { type: 'scatterpolar', r: [null], theta: [labels[0]], mode: 'lines', line: { color: '#ced4da', width: 1 }, name: AP.t('pd.logScale', { inner: '10 µM', outer: `${AP.fmt(0.1, 1)} nM` }), hoverinfo: 'skip' },
      { type: 'scatterpolar', r: close(T.map(() => FLOOR)), theta: close(labels), mode: 'lines', line: { color: '#ced4da', width: 1.5, dash: 'dot' }, name: AP.t('pd.detectionLimit'), hoverinfo: 'name' },
      layer(d && d.pd.ki, d?.color || '#3B6FD8', comps.length ? AP.t('pd.affinityOf', { name: d.pd.label || d.name }) : AP.t('pd.affinity'), undefined, (d && d.pd.nd) || []),
      ...comps.map(c => layer(c.ki, c.color, AP.t('pd.affinityOf', { name: c.label || c.name }), 'dash')),
    ];

    // Functional EC50 measured at the receptor in the laboratory, only where the drug activates it (agonist or
    // partial agonist): markers without a line, since most targets have no such value
    const fec = d && d.pd.fec50;
    if (fec) {
      const em = d.pd.femax || {};
      traces.push({
        type: 'scatterpolar', mode: 'markers', theta: labels, name: AP.t('pd.funcLayer'),
        r: T.map(t => (fec[t] ? +(9 - Math.log10(fec[t])).toFixed(2) : null)),
        marker: { size: 12, symbol: 'star', color: '#f08c00', line: { color: '#ffffff', width: 1 } },
        text: T.map(t => (fec[t] ? AP.t(em[t] !== undefined ? 'pd.funcHoverEmax' : 'pd.funcHover', { ec50: AP.fmtAuto(fec[t]), emax: AP.fmt((em[t] || 0) * 100) }) : '')), hoverinfo: 'theta+text',
      });
    }

    // Potency per target: pEC50 = −log10 of the plasma concentration (M) giving 50 % occupancy, and a ring at the
    // steady-state plasma concentration of the usual dose on the same scale: potency points outside the ring
    // are more than half occupied at that dose (D2 included, as its EC50 accounts for dopamine competition).
    const pot = d && d.pk ? usualFree(d) : null;
    const pM = (ngml) => 6 - Math.log10(ngml / d.mw);   // ng/mL → −log10(mol/L)
    const clamp = (x) => Math.min(10.5, Math.max(4.5, +x.toFixed(2)));
    if (pot) {
      const ec = T.map(t => Models.plasmaEC50(d, t));
      traces.push({
        type: 'scatterpolar', r: close(ec.map(e => (Number.isFinite(e) ? clamp(pM(e)) : FLOOR))), theta: close(labels), mode: 'lines+markers',
        line: { color: '#495057', width: 2, dash: 'dot' }, marker: { size: 6, color: '#495057', symbol: 'diamond' }, name: AP.t('pd.potencyLayer'),
        text: close(ec.map((e, i) => (Number.isFinite(e) ? AP.t('pd.potencyHover', { ec50: AP.fmtAuto(AP.conc(e, d.mw)), unit: AP.concUnit(), p: AP.fmt(pM(e), 2) }) : AP.t(Models.isNd(d, T[i]) ? 'pd.notDetermined' : 'pd.notBoundKi')))), hoverinfo: 'theta+text',
      });
      traces.push({
        type: 'scatterpolar', r: close(T.map(() => clamp(pM(pot.cp)))), theta: close(labels), mode: 'lines',
        line: { color: '#212529', width: 2, dash: 'longdash' }, name: AP.t('pd.usualRing', { conc: `${AP.fmtAuto(AP.conc(pot.cp, d.mw))} ${AP.concUnit()}` }),
        text: close(T.map(t => AP.t('pd.usualRingHover', { occ: pct(Models.occupancy(drugKey, t, pot.free) * 100), dose: AP.fmtAuto(pot.daily) }))), hoverinfo: 'theta+text',
      });
    }

    Plotly.react(target, traces, {
      ...plotBase(),
      polar: {
        // log10 scale: −log10 of the concentration in M; one grid ring per tenfold step, explained in the legend
        radialaxis: { visible: true, range: [4.5, 10.5], tickvals: [5, 6, 7, 8, 9, 10], showticklabels: false, ticks: '', gridcolor: '#e9ecef', linecolor: '#dee2e6' },
        angularaxis: { gridcolor: '#e9ecef', linecolor: '#dee2e6', direction: 'clockwise', rotation: 90 },
      },
      margin: { l: 50, r: 50, t: 25, b: 25 },
      showlegend: true, legend: { orientation: 'h', y: -0.12, x: 0 },
    }, { responsive: true, displayModeBar: false });

    // Scale conversion under the chart: each ring is a tenfold step (Kᵢ or plasma EC50, molar)
    const scale = document.getElementById('pd-sel-scale');
    if (scale) {
      const bands = [['5', 'pd.scale.veryHigh', '≤ 1 nM'], ['4', 'pd.scale.high', '1-10 nM'], ['3', 'pd.scale.moderate', '10-100 nM'],
        ['2', 'pd.scale.low', '100-1000 nM'], ['1', 'pd.scale.veryLow', '1-10 µM'], ['0', 'pd.scale.none', '> 10 µM']];
      scale.innerHTML = `<b>${AP.t('pd.scale.title')}</b> ${bands.map(([n, k, c]) => `<span><i>${n}</i> ${AP.t(k)} <code>${c}</code></span>`).join('')}`;
    }

    const summary = document.getElementById('pd-sel-summary');
    if (!summary) return;
    if (!d) { summary.innerHTML = AP.t('pd.selNoDrug'); return; }
    const ki = d.pd.ki;
    const ratio = (ki.ht2a < AP.NB && ki.d2 < AP.NB) ? ki.d2 / ki.ht2a : null;
    const bound = T.filter(t => ki[t] < AP.NB).sort((a, b) => ki[a] - ki[b]);
    const kiTxt = (t) => `${AP.targets[t].label} ${AP.fmtAuto(ki[t])} nM`;
    const nd = (d.pd.nd || []).filter(t => T.includes(t));
    const ndTxt = nd.length ? ` ${AP.t('pd.selNotDetermined', { list: nd.map(t => AP.targets[t].label).join(', ') })}` : '';
    summary.innerHTML = (!bound.length ? AP.t('pd.selNoKi', { drug: d.name }) : AP.t('pd.selSummary', {
      drug: d.name, top: AP.targets[bound[0]].label, topKi: AP.fmtAuto(ki[bound[0]]), order: bound.map(kiTxt).join(' < '),
      ratio: ratio === null ? '' : AP.t(ratio >= 1 ? 'pd.ratioHt2a' : 'pd.ratioD2', { r: AP.fmt(ratio >= 1 ? ratio : 1 / ratio, 1) }),
    })) + ndTxt + (pot ? ' ' + AP.t('pd.potencySummary', {
      dose: AP.fmtAuto(pot.daily), conc: `${AP.fmtAuto(AP.conc(pot.cp, d.mw))} ${AP.concUnit()}`,
      ec50: T.filter(t => Number.isFinite(Models.plasmaEC50(d, t))).sort((a, b) => Models.plasmaEC50(d, a) - Models.plasmaEC50(d, b))
        .map(t => `${AP.targets[t].label} ${AP.fmtAuto(AP.conc(Models.plasmaEC50(d, t), d.mw))}`).join(' < '), unit: AP.concUnit(),
      list: T.filter(t => Models.occupancy(drugKey, t, pot.free) >= 0.5).map(t => `${AP.targets[t].label} ${pct(Models.occupancy(drugKey, t, pot.free) * 100)}`).join(', ') || AP.t('pd.potencyNone'),
    }) : '') + (fec ? ' ' + AP.t('pd.funcSummary', {
      list: T.filter(t => fec[t]).map(t => `${AP.targets[t].label} ${AP.fmtAuto(fec[t])} nM${(d.pd.femax || {})[t] !== undefined ? ` (E<sub>max</sub> ${AP.fmt(d.pd.femax[t] * 100)} %)` : ''}`).join(', '),
    }) : '') + (comps.length ? ' ' + AP.t('pd.selLayers', {
      drug: d.pd.label || d.name, list: comps.map(c => `${c.name} (${T.filter(t => c.ki[t] < AP.NB).map(t => `${AP.targets[t].label} ${AP.fmtAuto(c.ki[t])} nM`).join(', ')})`).join(', '),
    }) : '') + (d.pd.note ? ` ${d.pd.note}` : '');
  }

  /**
   * Steady-state average plasma concentration per mg of the usual oral regimen (D2-active moiety),
   * with the patient settings of the Pharmacokinetics section; scales linearly with dose. Doses are
   * repeated for six half-lives of the slowest species and the average is taken over the last dosing
   * interval only (the same steady state the EC50 values were calibrated with).
   */
  function steadyStatePerMg(d) {
    const mods = [...document.querySelectorAll('#pk-mods input:checked')].map(cb => cb.value);
    const weight = AP.numInput('pk-wt', 70);
    const reg = Models.regimenFor(d, 'oral');
    const tau = reg.tau;
    const probe = 10;
    const e = Models.effectivePK(d, mods, weight);
    const n = Math.max(6, Math.ceil(6 * Math.max(e.t12, ...e.metabolites.map(m => m.t12)) / tau) + 1);
    const sim = Models.simulate({ drug: d, dose: probe, route: d.routes.includes('oral') ? 'oral' : d.defaultRoute, n, tau, weight, mods, tEnd: n * tau });
    const last = sim.doseTimes[sim.doseTimes.length - 1];
    const idx = sim.t.map((t, i) => [t, i]).filter(([t]) => t >= last && t <= last + tau).map(([, i]) => i);
    return { reg, cssPerMg: (idx.reduce((a, i) => a + sim.moiety[i], 0) / idx.length) / probe };
  }

  /** Free concentration (nM) at steady state on the usual oral regimen, and the daily dose */
  function usualFree(d) {
    const { reg, cssPerMg } = steadyStatePerMg(d);
    const cp = cssPerMg * reg.dose;
    return { cp, free: Models.freeFromPlasma(d, cp), daily: reg.dose * 24 / reg.tau };
  }

  /** Plot D: dose-occupancy relationship at steady state */
  function plotDoseOccupancy(drugKey) {
    const target = document.getElementById('pd-plot-dose');
    if (!target) return;
    const key = drugKey !== 'none' ? drugKey : 'risperidone';
    const d = AP.drugs[key];
    if (!d || !d.pk) return;
    if (d.pd.ki.d2 >= AP.NB) {
      Plotly.react(target, [], {
        ...plotBase(), xaxis: { visible: false }, yaxis: { visible: false }, margin: { l: 20, r: 20, t: 20, b: 20 },
        annotations: [{ xref: 'paper', yref: 'paper', x: 0.5, y: 0.5, showarrow: false, text: AP.t('pd.doseNoD2Short', { drug: d.name }), font: AP.plotFont({ color: '#868e96' }) }],
      }, { responsive: true, displayModeBar: false });
      const summary = document.getElementById('pd-dose-summary');
      if (summary) summary.innerHTML = AP.t('pd.doseNoD2', { drug: d.name });
      return;
    }

    // steady-state average concentration scales linearly with dose: one simulation is enough
    const { reg, cssPerMg } = steadyStatePerMg(d);
    const tau = reg.tau;

    const perDay = 24 / tau;
    const daily = [];
    for (let lg = -1.2; lg <= 1.4; lg += 0.02) daily.push(reg.dose * perDay * Math.pow(10, lg));
    const occFor = (dosePerDay, da) => Models.occupancy(key, 'd2', Models.freeFromPlasma(d, cssPerMg * dosePerDay / perDay), da) * 100;
    const iaD2 = Models.ia(d, 'd2');
    const usual = reg.dose * perDay;

    const traces = Object.entries(AP.pathways).map(([k, p]) => ({
      x: daily, y: daily.map(x => occFor(x, p.da)), type: 'scatter', mode: 'lines',
      name: AP.t('pd.dosePathway', { pathway: p.label, da: AP.fmt(p.da) }),
      line: { width: k === 'mesolimbic' ? 3.2 : 2, dash: k === 'mesolimbic' ? 'solid' : 'dot' },
    }));
    traces.push({
      x: [usual, usual], y: [0, 100], type: 'scatter', mode: 'lines',
      name: AP.t('pd.usualDose', { dose: AP.fmtAuto(usual) }), line: { color: '#c92a2a', width: 2, dash: 'dash' },
    });

    const T = Models.THRESH;
    const shapes = [[T.response * 100, T.eps * 100, 'rgba(43,138,62,0.10)'], [T.eps * 100, 100, 'rgba(201,42,42,0.08)']]
      .map(([y0, y1, c]) => ({ type: 'rect', xref: 'paper', x0: 0, x1: 1, y0, y1, fillcolor: c, line: { width: 0 }, layer: 'below' }));
    const annotations = [
      { xref: 'paper', x: 0.01, y: (T.response + T.eps) / 2 * 100, text: AP.t('pd.windowBand', { lo: AP.fmt(T.response * 100), hi: AP.fmt(T.eps * 100) }), showarrow: false, xanchor: 'left', font: AP.plotFont({ size: 11, color: '#2b8a3e' }) },
      { xref: 'paper', x: 0.01, y: 90, text: AP.t('pd.aboveBand', { hi: AP.fmt(T.eps * 100) }), showarrow: false, xanchor: 'left', font: AP.plotFont({ size: 11, color: '#c92a2a' }) },
    ];

    Plotly.react(target, traces, {
      ...plotBase(), ...legendBelow,
      xaxis: { type: 'log', title: { text: AP.t('pd.axisDailyDose'), standoff: 8 }, automargin: true, gridcolor: '#f1f3f5' },
      yaxis: { title: { text: AP.t('pd.axisStriatalOcc') }, range: [0, 100], gridcolor: '#f1f3f5' },
      shapes, annotations,
      margin: { l: 55, r: 20, t: 25, b: 115 },
    }, { responsive: true, displayModeBar: false });

    const summary = document.getElementById('pd-dose-summary');
    if (!summary) return;
    // PET occupancy is measured in the striatum at tonic dopamine, the condition the calibration was
    // fitted to; the raised mesolimbic level is shown for comparison.
    const DA_TONIC = AP.DA.TONIC, DA_MESO = AP.pathways.mesolimbic.da;
    const doseFor = (p, da) => { const f = daily.find(x => occFor(x, da) >= p); return f ? AP.fmtAuto(f) : null; };
    const d65 = doseFor(T.response * 100, DA_TONIC), d78 = doseFor(T.eps * 100, DA_TONIC);
    const fmtT = (x) => AP.fmt(x * 100);
    summary.innerHTML = [
      AP.t('pd.doseIntro'),
      AP.t('pd.doseUsual', { drug: d.name, dose: AP.fmtAuto(usual), occ: pct(occFor(usual, DA_TONIC)), da: AP.fmt(DA_TONIC) }),
      d65 ? AP.t(d78 ? 'pd.doseReachesBoth' : 'pd.doseReaches', { d65, d78, lo: fmtT(T.response), hi: fmtT(T.eps) }) : AP.t('pd.doseNotReached', { lo: fmtT(T.response) }),
      iaD2 > 0 ? AP.t('pd.dosePartial', { drug: d.name, ia: AP.fmt(iaD2, 2), iaPct: AP.fmt(iaD2 * 100) }) : '',
      AP.t('pd.dosePathways', { da: AP.fmt(DA_MESO), occ: pct(occFor(usual, DA_MESO)) }),
      `<span class="dose-model-note">${AP.t('pd.doseNote', { a: fmtT(T.response), b: fmtT(T.prolactin), c: fmtT(T.eps) })}</span>`,
    ].filter(Boolean).join(' ');
  }

  /** Target cards (section 2) with live occupancy for the selected drug */
  function renderTargetCards(drugKey, cNM, daNM) {
    const grid = document.getElementById('pd-targets-grid');
    const badge = document.getElementById('pd-occ-summary-badge');
    if (!grid) return;
    const drug = drugKey !== 'none' ? AP.drugs[drugKey] : null;

    if (badge) {
      badge.textContent = drug ? `${drug.name} @ ${fmtConc(cNM)}` : AP.t('pd.noDrugSelected');
      badge.style.background = drug ? (drug.color || 'var(--accent)') : '#868e96';
    }

    const status = (bg, fg, text) => `<span class="sub-effect-status" style="background:${bg}; color:${fg};">${text}</span>`;
    let html = targets().map(k => {
      const t = AP.targets[k];
      const nd = Models.isNd(drug, k);
      const ki = drug ? (drug.pd.ki[k] ?? AP.NB) : AP.NB;
      const binds = ki < AP.NB || (nd && k === 'd2' && !!drug.pd.ec50);   // D2 without Kᵢ: occupancy from the PET-calibrated EC50
      const occPct = binds ? Models.occupancy(drugKey, k, cNM, daNM) * 100 : 0;
      const iaVal = drug ? Models.ia(drug, k) : 0;
      const agonist = !!(drug && binds && !iaVal && drug.pd.action && drug.pd.action[k] === 'agonist');
      const fx = agonist && t.agonism ? t.agonism : t;

      let st, barColor = '#adb5bd';
      if (!drug) st = status('#e9ecef', '#868e96', AP.t('pd.noDrugSelected'));
      else if (!binds) st = status('#dee2e6', '#495057', AP.t(nd ? 'pd.card.notDetermined' : 'pd.card.noBinding'));
      else if (occPct >= 50) { st = status('#2b8a3e', '#fff', AP.t('pd.card.high', { pct: pct(occPct) })); barColor = '#2b8a3e'; }
      else if (occPct >= 15) { st = status('#f59f00', '#fff', AP.t('pd.card.moderate', { pct: pct(occPct) })); barColor = '#f59f00'; }
      else if (occPct > 0.5) { st = status('#868e96', '#fff', AP.t('pd.card.low', { pct: pct(occPct, 1) })); barColor = '#868e96'; }
      else st = status('#e9ecef', '#868e96', AP.t('pd.card.belowOne'));

      return `
        <div class="sub-effect-card ${!binds && drug ? 'insensitive' : ''}${k === currentTarget() ? ' active-isoform' : ''}" data-target-key="${k}" title="${AP.t('pd.card.showMap', { target: t.label })}">
          <div class="sub-effect-header">
            <div class="sub-effect-title">
              <span class="sub-effect-badge" style="background:${t.color};">${t.label}</span>
            </div>
            ${st}
          </div>
          <div class="sub-facts">
            <div>${AP.t('pd.card.endogenous', { ligand: t.endogenous })}</div>
            ${drug ? `<div>${AP.t('pd.card.ki', { drug: drug.name, ki: nd ? AP.t('pd.notDetermined') : binds ? `${AP.fmtAuto(ki)} nM` : AP.t('pd.card.notBound') })}</div>` : ''}
            ${drug && binds && drug.pk ? `<div>${AP.t('pd.card.ec50', { ec50: AP.fmtAuto(AP.conc(Models.plasmaEC50(drug, k), drug.mw)), unit: AP.concUnit() })}</div>` : ''}
            ${drug && iaVal > 0 ? `<div>${AP.t('pd.card.ia', { ia: AP.fmt(iaVal, 2) })}</div>` : ''}
            ${agonist ? `<div>${AP.t('pd.card.agonist')}</div>` : ''}
            ${k === 'd2' ? `<div>${AP.t('pd.card.daCompetition', { da: AP.fmt(daNM), k: AP.fmt(AP.DA.K) })}</div>` : ''}
          </div>
          <div class="sub-occ-wrapper">
            <div class="sub-occ-head">
              <span>${AP.t('pd.card.occAt', { conc: fmtConc(cNM) })}</span>
              <span><b>${drug && binds ? pct(occPct, 1) : (drug ? AP.t('pd.card.notBound') : '-')}</b></span>
            </div>
            <div class="sub-occ-bar-bg"><div class="sub-occ-bar-fill" style="width:${occPct.toFixed(1)}%; background-color:${barColor};"></div></div>
          </div>
          <div class="sub-effects">${AP.t('pd.card.effectsTitle')} ${fx.effect}. ${fx.clinical}</div>
          <div class="sub-loc">${AP.t('pd.card.distribution', { location: t.location })}</div>
        </div>`;
    }).join('');

    html += (AP.otherTargets || []).map(o => `
      <div class="sub-effect-card" title="${o.label}">
        <div class="sub-effect-header">
          <div class="sub-effect-title">
            <span class="sub-effect-badge" style="background:${o.color};">${o.label.split(' ')[0]}</span>
          </div>
          ${status(o.color, '#fff', o.status)}
        </div>
        <div class="sub-facts">${o.facts.map(([k, v]) => `<div><b>${k}:</b> ${v}</div>`).join('')}</div>
        <div class="sub-effects">${AP.t('pd.card.effectsTitle')} ${o.effect}. ${o.clinical}</div>
        <div class="sub-loc">${AP.t('pd.card.distribution', { location: o.location })}</div>
      </div>`).join('');

    grid.innerHTML = html;

    grid.querySelectorAll('.sub-effect-card[data-target-key]').forEach(card => {
      card.addEventListener('click', () => {
        const k = card.getAttribute('data-target-key');
        if (k && window.syncTargetSelection) window.syncTargetSelection(k, 'target-card');
      });
    });
  }

  /** The receptor currently shown in the regional distribution map */
  function currentTarget() {
    const active = document.querySelector('#dist-panel .dist-pills button.active');
    return active ? active.getAttribute('data-sub-key') : 'd2';
  }

  /** Called when the receptor (section 1) slider moves */
  function syncConc() { updateLabels(); update(); }

  return { init, update, syncConc };
})();
