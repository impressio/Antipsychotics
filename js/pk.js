/* =====================================================================
 * pk.js - Pharmacokinetics simulation & visualizations
 * Powered by Plotly.js and Models.simulate. Concentrations are simulated in
 * ng/mL and shown in the unit of the selected region (AP.conc, AP.concUnit),
 * each species converted with its own molecular weight.
 * ===================================================================== */
window.PK = (function () {
  'use strict';

  /** Drug name for use mid-sentence (INNs are common nouns) */
  const inn = (name) => (/^[A-Z0-9-]+$/.test(name) ? name : name.replace(/[A-Z]/, c => c.toLowerCase()));

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
    attachAccumulationButtons();
    populateControls();
    populateRouteSelect();
    renderModifierPills();
    attachListeners();
    const drugKey = document.getElementById('pk-drug')?.value;
    if (drugKey) applyRegimen(drugKey, syncRouteOptions(drugKey));   // usual regimen at steady state
    waitForPlotly(update);
  }

  function populateControls() {
    const drugSel = document.getElementById('pk-drug');
    if (drugSel && drugSel.options.length === 0) {
      Object.entries(AP.drugs).forEach(([k, v]) => {
        if (!v.pk) return;
        const opt = Object.assign(document.createElement('option'), { value: k, textContent: `${v.name} (${v.role})` });
        if (k === 'risperidone') opt.selected = true;
        drugSel.appendChild(opt);
      });
    }
  }

  function renderModifierPills() {
    const container = document.getElementById('pk-mods');
    if (!container) return;
    container.innerHTML = `<span class="mods-title">${AP.t('pk.modsTitle')}</span>` +
      Object.entries(AP.modifiers).map(([k, m]) => `
        <label class="mod-pill" data-key="${k}" title="${m.desc}">
          <input type="checkbox" value="${k}" />
          <span>${m.short}</span>
        </label>`).join('');

    container.querySelectorAll('.mod-pill').forEach(pill => {
      const cb = pill.querySelector('input');
      cb?.addEventListener('change', () => { pill.classList.toggle('on', cb.checked); update(); });
    });
  }

  const ROUTE_ORDER = ['oral', 'odt', 'im', 'iv', 'lai'];

  const routeInfo = (routeKey) => (AP.routes || []).find(r => r.id === routeKey) || null;
  const getRouteLabel = (routeKey) => (routeInfo(routeKey) ? routeInfo(routeKey).name : String(routeKey).toUpperCase());
  const getAllowedRoutes = (drug) => (!drug ? ['oral'] : drug.routes || (drug.pk ? ['oral'] : []));

  function populateRouteSelect() {
    const routeSel = document.getElementById('pk-route');
    if (!routeSel) return;
    const current = routeSel.value;
    routeSel.innerHTML = '';
    ROUTE_ORDER.forEach(id => {
      routeSel.appendChild(Object.assign(document.createElement('option'), { value: id, textContent: getRouteLabel(id) }));
    });
    routeSel.value = ROUTE_ORDER.includes(current) ? current : 'oral';
  }

  /**
   * Enable only the routes the selected drug is formulated for and make sure
   * the current route is valid. Returns the (possibly corrected) route.
   */
  function syncRouteOptions(drugKey) {
    const routeSel = document.getElementById('pk-route');
    if (!routeSel) return null;
    const drug = AP.drugs[drugKey];
    if (!drug) return routeSel.value;
    const allowed = getAllowedRoutes(drug);

    Array.from(routeSel.options).forEach(opt => {
      const isAllowed = allowed.includes(opt.value);
      opt.disabled = !isAllowed;
      opt.hidden = !isAllowed;
      opt.textContent = isAllowed ? getRouteLabel(opt.value) : AP.t('pk.notFormulatedOption', { route: getRouteLabel(opt.value) });
    });

    if (!allowed.includes(routeSel.value)) {
      routeSel.value = (drug.defaultRoute && allowed.includes(drug.defaultRoute)) ? drug.defaultRoute : (allowed[0] || 'oral');
    }
    return routeSel.value;
  }

  /** Products of the drug by the route (e.g. depot brands, extended-release tablets); grayed out without a choice */
  function syncProductOptions(drugKey, route) {
    const sel = document.getElementById('pk-product');
    if (!sel) return;
    const drug = AP.drugs[drugKey];
    const list = drug ? Models.routeProducts(drug, route) : [];
    const cur = drug ? Models.routeProduct(drug, route) : null;
    sel.innerHTML = list.length ? list.map(p => `<option value="${p.key}">${p.name || AP.t('pk.productNone')}</option>`).join('')
      : `<option value="">${AP.t('pk.productNone')}</option>`;
    sel.value = cur ? cur.key : '';
    sel.disabled = list.length < 2;
  }

  /** Dose menu with the available strengths of an injection product; free input otherwise */
  function syncDoseOptions(drugKey, route) {
    const input = document.getElementById('pk-dose'), sel = document.getElementById('pk-dose-sel');
    if (!input || !sel) return;
    const drug = AP.drugs[drugKey];
    const st = drug ? Models.strengthsOf(Models.routeProduct(drug, route)) : [];
    input.hidden = st.length > 0;
    sel.hidden = !st.length;
    if (!st.length) return;
    const dose = parseFloat(input.value);
    const tau = parseFloat(document.getElementById('pk-tau')?.value);
    const product = Models.routeProduct(drug, route);
    // products whose strengths differ in interval show the interval of every strength
    const mixed = st.some(s => s.tau && s.tau !== product.tau);
    const tauOf = (s) => s.tau || product.tau;
    const text = (s) => {
      const base = s.mg === s.dose ? `${AP.fmt(s.mg)} mg` : AP.t('pk.strengthAs', { mg: AP.fmt(s.mg), dose: AP.fmt(s.dose), drug: inn(drug.name) });
      const t = mixed || s.tau ? tauOf(s) : 0;
      return t && t % 168 === 0 ? AP.t(t === 336 ? 'pk.strengthEvery2' : 'pk.strengthEvery', { dose: base, n: AP.fmt(t / 168) }) : base;
    };
    const opts = st.map((s, i) => [String(i), text(s)]);
    const match = (s) => Math.abs(s.dose - dose) < 1e-6;
    let idx = st.findIndex(s => match(s) && tauOf(s) === tau);
    if (idx < 0) idx = st.findIndex(s => match(s) && !s.tau);
    if (idx < 0) idx = st.findIndex(match);
    if (idx < 0) { opts.push(['custom', `${AP.fmt(dose)} mg`]); idx = 'custom'; }   // dose set elsewhere (e.g. section 1)
    sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    sel.value = String(idx);
  }

  /** Apply the usual dose and interval of a drug for a route (depots differ from oral) */
  function applyRegimen(drugKey, route) {
    const drug = AP.drugs[drugKey];
    if (!drug || !drug.pk) return;
    const reg = Models.regimenFor(drug, route);
    const doseEl = document.getElementById('pk-dose'), tauEl = document.getElementById('pk-tau');
    if (doseEl) doseEl.value = reg.dose;
    if (tauEl) tauEl.value = reg.tau;
    setSteadyStateDoses();
  }

  function attachListeners() {
    const routeEl = document.getElementById('pk-route');
    document.getElementById('pk-product')?.addEventListener('change', (ev) => {
      const drugKey = document.getElementById('pk-drug')?.value;
      const route = document.getElementById('pk-route')?.value || 'oral';
      Models.selectProduct(AP.drugs[drugKey], route, ev.target.value);
      applyRegimen(drugKey, route);
      update();
    });
    document.getElementById('pk-dose-sel')?.addEventListener('change', (ev) => {
      const drug = AP.drugs[document.getElementById('pk-drug')?.value];
      const route = document.getElementById('pk-route')?.value || 'oral';
      const product = Models.routeProduct(drug, route);
      const s = Models.strengthsOf(product)[+ev.target.value];
      if (!s) return;
      // a strength without its own interval uses the product's usual one (e.g. 400 mg monthly after 960 mg every 2 months)
      document.getElementById('pk-dose').value = s.dose;
      document.getElementById('pk-tau').value = s.tau || product.tau || drug.pk.tau;
      setSteadyStateDoses();
      update();
    });
    routeEl?.addEventListener('change', () => {
      applyRegimen(document.getElementById('pk-drug')?.value, routeEl.value);
      if (window.syncRouteSelection) window.syncRouteSelection(routeEl.value, 'pk-route');
      else update();
    });

    ['pk-dose', 'pk-n', 'pk-tau', 'pk-wt', 'pk-scale', 'pk-init'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', update);
      if (el.tagName === 'INPUT') el.addEventListener('input', update);
    });

    const drugSel = document.getElementById('pk-drug');
    drugSel?.addEventListener('change', () => {
      const val = drugSel.value;
      const route = syncRouteOptions(val);
      applyRegimen(val, route);
      if (window.syncDrugSelection) window.syncDrugSelection(val, 'pk-drug');
      else update();
    });
  }

  /** Number of doses that reaches steady state (the default view, since the reference range applies there) */
  function setSteadyStateDoses() {
    const nEl = document.getElementById('pk-n');
    const drug = AP.drugs[document.getElementById('pk-drug')?.value || 'risperidone'];
    if (!drug || !drug.pk || !nEl) return;
    const route = document.getElementById('pk-route')?.value || 'oral';
    const tau = AP.numInput('pk-tau', drug.pk.tau || 24), dose = AP.numInput('pk-dose', drug.pk.dose);
    // acute injections (short-acting IM, IV): a single dose; otherwise until 95 % of steady state plus two intervals
    if (route === 'im' || route === 'iv') { nEl.value = 1; return; }
    const ss = steadyStateOf(drug, route, dose, tau, route === 'lai' ? syncInitOptions(drug, route, dose, tau) : null);
    nEl.value = Math.min(+nEl.max || 365, Math.max(4, (ss.t95 ? ss.t95.dose : ss.n) + 2));
  }

  function attachAccumulationButtons() {
    const nEl = document.getElementById('pk-n');
    document.getElementById('pk-accum-btn')?.addEventListener('click', () => { setSteadyStateDoses(); update(); });
    document.getElementById('pk-single-btn')?.addEventListener('click', () => {
      if (nEl) { nEl.value = 1; update(); }
    });
  }

  const getSelectedModifiers = () => [...document.querySelectorAll('#pk-mods input:checked')].map(cb => cb.value);

  /**
   * Steady state of the current regimen from Models.steadyState (explicit convergence: the first maintenance dose
   * from which the D2-active level stays within 10/5/1 % of its exact asymptote), cached per regimen.
   */
  let ssCache = { key: '', value: null };
  function steadyStateOf(drug, route, dose, tau, initiation) {
    const mods = getSelectedModifiers(), weight = AP.numInput('pk-wt', 70);
    const product = Models.routeProduct(drug, route);
    const key = JSON.stringify([drug.name, route, product && product.key, dose, tau, weight, mods, initiation]);
    if (ssCache.key !== key) ssCache = { key, value: Models.steadyState({ drug, dose, route, tau, weight, mods, initiation }) };
    return ssCache.value;
  }

  /** Initiation regimens of the product for the current maintenance dose; the label's first one by default */
  let initSig = '';
  function syncInitOptions(drug, route, dose, tau) {
    const sel = document.getElementById('pk-init');
    if (!sel) return null;
    const product = route === 'lai' ? Models.routeProduct(drug, route) : null;
    const inits = product ? Models.initiationsFor(product, dose, tau) : {};
    const keys = Object.keys(inits);
    const sig = [drug.name, route, product && product.key, dose, tau].join('|');
    const label = (k) => {
      const it = inits[k], oral = (it.items || []).find(x => x.route === 'oral' && x.for_d);
      return AP.t(`pk.init.${it.type || 'loading'}`, { days: oral ? AP.fmt(oral.for_d) : '' });
    };
    const prev = sel.value;
    sel.innerHTML = [`<option value="none">${AP.t('pk.init.none')}</option>`].concat(keys.map(k => `<option value="${k}">${label(k)}</option>`)).join('');
    sel.value = sig !== initSig ? (keys[0] || 'none') : (keys.includes(prev) ? prev : 'none');
    initSig = sig;
    sel.disabled = !keys.length;
    return sel.value !== 'none' ? inits[sel.value] : null;
  }

  function update() {
    if (typeof Plotly === 'undefined') { waitForPlotly(update); return; }
    const drugKey = document.getElementById('pk-drug')?.value || 'risperidone';
    const drug = AP.drugs[drugKey];
    if (!drug || !drug.pk) return;

    syncRouteOptions(drugKey);
    const route = document.getElementById('pk-route')?.value || 'oral';
    syncProductOptions(drugKey, route);
    syncDoseOptions(drugKey, route);
    const dose = AP.numInput('pk-dose', drug.pk.dose);
    const n = AP.numInput('pk-n', 1, true);
    const tau = AP.numInput('pk-tau', drug.pk.tau);
    const weight = AP.numInput('pk-wt', 70);
    const scale = document.getElementById('pk-scale')?.value || 'linear';
    const mods = getSelectedModifiers();

    const initiation = syncInitOptions(drug, route, dose, tau);
    const sim = Models.simulate({ drug, dose, route, n, tau, weight, mods, initiation });
    sim.initiation = initiation;

    plotConcentrationTime(sim, drug, scale, route);
    renderParamsTable(sim, drug, route);
    plotDurationComparison(weight, mods);

    if (window.Routes && typeof window.Routes.reflect === 'function') window.Routes.reflect(route, drugKey);
    if (window.Receptor && typeof window.Receptor.syncFromPK === 'function') window.Receptor.syncFromPK();
  }

  /* ---------- Units and formatting ---------- */
  const unit = () => AP.concUnit();
  /** Concentration series of one species in the regional unit */
  const conv = (series, mw) => series.map(v => AP.conc(v, mw));
  const days = (h) => (h / 24 < 1 ? AP.t('pk.hours', { n: AP.fmt(h) }) : AP.t('pk.days', { n: AP.fmt(h / 24, 1) }));
  const plotBase = () => ({
    font: AP.plotFont(), hoverlabel: AP.plotHover(), separators: AP.plotSeparators(),
    plot_bgcolor: '#ffffff', paper_bgcolor: '#ffffff',
  });

  /** Time axis in hours or days depending on the span */
  const timeAxis = (tEnd) => (tEnd > 24 * 7 ? { div: 24, label: AP.t('pk.axisDays') } : { div: 1, label: AP.t('pk.axisHours') });

  /** Plasma concentration vs time */
  function plotConcentrationTime(sim, drug, scale, route) {
    const target = document.getElementById('pk-plot-ct');
    if (!target) return;
    const ax = timeAxis(sim.tEnd);
    const X = sim.t.map(t => t / ax.div);
    const traces = [];
    const cp = conv(sim.cp, drug.mw);

    if (drug.pk.ref) {
      const [lo, hi] = drug.pk.ref.map(v => AP.conc(v, drug.mw));
      traces.push({
        x: [0, sim.tEnd / ax.div, sim.tEnd / ax.div, 0], y: [lo, lo, hi, hi],
        fill: 'toself', fillcolor: 'rgba(56, 217, 169, 0.12)', line: { color: 'transparent' },
        name: AP.t('pk.refRange', { analyte: drug.pk.refAnalyte === 'moiety' ? AP.t('pk.moietyShort') : inn(drug.name), lo: AP.fmtAuto(lo), hi: AP.fmtAuto(hi), unit: unit() }), hoverinfo: 'none',
      });
    }

    const routeLabel = sim.product && sim.product.name ? sim.product.name : route === 'iv' ? 'IV' : getRouteLabel(route).replace(/\s*\(.*\)/, '').toLowerCase();
    traces.push({ x: X, y: cp, type: 'scatter', mode: 'lines', name: `${drug.name} (${routeLabel})`, line: { color: drug.color || '#1971c2', width: 3 } });

    const dashStyles = ['dash', 'dashdot', 'dot', 'longdash'];
    const metCp = (sim.metabolites || []).map(m => conv(m.cp, m.mw));
    (sim.metabolites || []).forEach((m, idx) => {
      if (m.cp.some(v => v > 0.02)) {
        traces.push({
          x: X, y: metCp[idx], type: 'scatter', mode: 'lines',
          name: AP.t(m.d2 ? 'pk.metaboliteD2' : 'pk.metabolite', { name: m.name, t12: days(m.t12) }),
          line: { color: m.color, width: 2.3, dash: dashStyles[idx % dashStyles.length] },
        });
      }
    });

    // Co-formulated compounds (e.g. trospium), simulated with their own kinetics
    (sim.components || []).forEach(c => {
      traces.push({
        x: X, y: conv(c.cp, c.mw), type: 'scatter', mode: 'lines',
        name: AP.t('pk.component', { name: c.name, dose: AP.fmtAuto(c.dose), t12: days(c.t12) }),
        line: { color: c.color, width: 2.5 },
      });
    });

    // D2-active moiety (parent + metabolites that bind D2), the quantity that drives occupancy
    const d2Idx = (sim.metabolites || []).map((m, i) => (m.d2 && m.cp.some(v => v > 0.02) ? i : -1)).filter(i => i >= 0);
    if (d2Idx.length) {
      const moiety = cp.map((c, i) => c + d2Idx.reduce((s, j) => s + metCp[j][i], 0));
      traces.push({ x: X, y: moiety, type: 'scatter', mode: 'lines', name: AP.t('pk.moietySum'), line: { color: '#212529', width: 1.8 }, opacity: 0.8 });
    }

    // Accumulation: pre-dose troughs and predicted steady-state averages
    const annotations = [];
    if (sim.doseTimes.length > 1) {
      const troughIdx = sim.doseTimes.slice(1).map(dt => {
        const i = sim.t.findIndex(t => t >= dt);
        return Math.max(0, (i < 0 ? sim.t.length : i) - 1);
      });
      const series = [{ name: drug.name, cp, color: drug.color || '#1971c2' }]
        .concat(d2Idx.map(j => ({ name: sim.metabolites[j].name, cp: metCp[j], color: sim.metabolites[j].color })));
      series.forEach((sr, k) => {
        traces.push({
          x: troughIdx.map(i => X[i]), y: troughIdx.map(i => sr.cp[i]),
          type: 'scatter', mode: 'lines+markers', name: k === 0 ? AP.t('pk.troughs') : '', showlegend: k === 0,
          line: { color: sr.color, width: 1.5, dash: 'dot' }, marker: { size: 5, color: sr.color, symbol: 'diamond' },
          hovertemplate: `${sr.name}: %{y:.1f} ${unit()}<extra></extra>`,
        });
      });
      steadyStateLevels(sim, drug).forEach(l => {
        const css = AP.conc(l.css, l.mw);
        traces.push({ x: [0, sim.tEnd / ax.div], y: [css, css], type: 'scatter', mode: 'lines', showlegend: false, line: { color: l.color, width: 1.2, dash: 'longdash' }, hoverinfo: 'skip' });
        annotations.push({
          x: sim.tEnd / ax.div, y: css, xanchor: 'right', yanchor: 'bottom', showarrow: false,
          text: AP.t(sim.depot ? 'pk.cssAnnotationDepot' : 'pk.cssAnnotation', { name: l.name, css: AP.fmtAuto(css), r: AP.fmt(l.R, 1) }), font: AP.plotFont({ color: l.color }),
        });
      });
      const top = Math.max(...cp, ...traces.filter(tr => tr.y && tr.mode === 'lines' && !tr.fill).flatMap(tr => tr.y)) * 1.05;
      sim.doseTimes.forEach((dt, idx) => {
        traces.push({
          x: [dt / ax.div, dt / ax.div], y: [0, top], type: 'scatter', mode: 'lines',
          name: idx === 0 ? AP.t(sim.depot ? 'pk.injectionGiven' : 'pk.doseGiven') : '', showlegend: idx === 0,
          line: { color: '#adb5bd', width: 1, dash: 'dot' }, hoverinfo: 'none',
        });
      });
    }
    // initiation (loading) injections; oral overlap is described in the summary below the plot
    const initTimes = (sim.extras || []).filter(x => x.route !== 'oral').flatMap(x => x.times);
    if (initTimes.length) {
      const top = Math.max(...traces.filter(tr => tr.y && tr.mode === 'lines' && !tr.fill).flatMap(tr => tr.y)) * 1.05;
      initTimes.forEach((dt, idx) => traces.push({
        x: [dt / ax.div, dt / ax.div], y: [0, top], type: 'scatter', mode: 'lines',
        name: idx === 0 ? AP.t('pk.initInjection') : '', showlegend: idx === 0,
        line: { color: '#f08c00', width: 1.2, dash: 'dash' }, hoverinfo: 'none',
      }));
    }

    Plotly.react(target, traces, {
      ...plotBase(),
      xaxis: { title: { text: AP.t('pk.axisTime', { unit: ax.label }), standoff: 8 }, automargin: true, gridcolor: '#f1f3f5' },
      yaxis: { title: { text: AP.t('pk.axisConc', { unit: unit() }) }, type: scale === 'log' ? 'log' : 'linear', gridcolor: '#f1f3f5', rangemode: scale === 'log' ? 'normal' : 'tozero' },
      margin: { l: 60, r: 25, t: 30, b: 130 }, annotations,
      showlegend: true, legend: { orientation: 'h', yanchor: 'top', y: -0.30, x: 0 },
    }, { responsive: true, displayModeBar: false });

    renderAccumulationSummary(sim, drug, route);
  }

  /**
   * Predicted steady-state averages (ng/mL) for the parent and its direct metabolites:
   * C_ss,avg = F·D/(CL·τ) (parent); f_m·F·D/(CL_m·τ) (metabolite; f_m multiplied along a chain); R = 1/(1 − e^(−kτ)).
   */
  function steadyStateLevels(sim, drug) {
    const tau = sim.doseTimes[1] - sim.doseTimes[0];
    const dose = sim.params.auc * sim.params.CL / sim.params.F / 1000;   // recover the dose (mg)
    const out = [{ name: drug.name, mw: drug.mw, color: drug.color || '#1971c2', css: sim.params.cssAvg, R: sim.params.R, t12: sim.params.t12 }];
    const defs = drug.pk.metabolites || [];
    // fraction of the dose that becomes each metabolite, along its chain (e.g. cariprazine → DCAR → DDCAR)
    const fmOf = (d) => (!d ? 0 : (d.from || 'parent') === 'parent' ? d.fm : d.fm * fmOf(defs.find(x => x.key === d.from)));
    (sim.metabolites || []).forEach((m, i) => {
      const d = defs[i];
      if (!d || !d.fm || !m.CL) return;
      const k = m.CL / m.V;
      out.push({ name: m.name, mw: m.mw, color: m.color, css: fmOf(d) * sim.params.F * dose / (m.CL * tau) * 1000, R: 1 / (1 - Math.exp(-k * tau)), t12: m.t12 });
    });
    (sim.components || []).forEach(c => {
      if (c.cssAvg) out.push({ name: c.name, mw: c.mw, color: c.color, css: c.cssAvg, R: 1 / (1 - Math.exp(-Math.LN2 / c.t12 * tau)), t12: c.t12 });
    });
    return out.filter(l => l.css > 0.1);
  }

  /** Initiation regimen in words: loading injections, extra products and oral overlap */
  function initiationNote(sim, drug) {
    if (!sim.extras || !sim.extras.length) return '';
    const day = (h) => AP.fmt(h / 24 + 1);   // label days count from day 1
    const items = sim.extras.map(x => {
      if (x.route === 'oral') {
        return x.times.length > 1
          ? AP.t('pk.initItemOral', { dose: AP.fmt(x.dose), every: AP.t('pk.hours', { n: AP.fmt(x.times[1] - x.times[0]) }), days: AP.fmt((x.times[x.times.length - 1] - x.times[0] + (x.times[1] - x.times[0])) / 24) })
          : AP.t('pk.initItemOralOnce', { dose: AP.fmt(x.dose), days: day(x.times[0]) });
      }
      return AP.t('pk.initItemInjection', { name: x.name ? `${x.name} ` : '', dose: AP.fmt(x.mg), days: x.times.map(day).join(', ') });
    });
    return `<br/>${AP.t('pk.initNote', { items: items.join('; '), start: day(sim.start || 0) })}`;
  }

  /** The analyte that drives D2 occupancy: the active moiety when metabolites are D2-active, else the drug */
  const hasMoiety = (drug) => (drug.pk.metabolites || []).some(m => m.d2);
  const analyteName = (drug) => (hasMoiety(drug) ? AP.t('pk.moietyShort') : inn(drug.name));

  /** Time to 90, 95 and 99 % of the steady-state average (D2-active level), from the convergence criterion */
  function convergenceNote(ss, drug) {
    const at = (x) => (x ? AP.t('pk.ssAt', { k: x.dose, t: days(x.t) }) : AP.t('pk.ssBeyond'));
    return AP.t('pk.ssConvergence', { analyte: analyteName(drug), t90: at(ss.t90), t95: at(ss.t95), t99: at(ss.t99) });
  }

  function renderAccumulationSummary(sim, drug, route) {
    const el = document.getElementById('pk-accum-summary');
    if (!el) return;
    const tAbs = sim.params.tAbs;
    // flip-flop kinetics: a first-order release slower than elimination (not a delayed release window)
    const absLimited = route === 'lai' && tAbs > sim.params.t12 && sim.params.releaseEnd < tAbs;
    const interval = (tau) => (tau >= 48 ? AP.t('pk.days', { n: AP.fmt(tau / 24) }) : AP.t('pk.hours', { n: AP.fmt(tau) }));

    if (sim.depot) {
      // depots: time to steady state from a simulation of repeated injections (release lags and windows included)
      const tau = sim.doseTimes.length > 1 ? sim.doseTimes[1] - sim.doseTimes[0] : AP.numInput('pk-tau', sim.depot.tau);
      const dose = sim.params.auc * sim.params.CL / sim.params.F / 1000;
      const ss = steadyStateOf(drug, route, dose, tau, sim.initiation);
      const t90 = ss.t90 || { dose: ss.n, t: ss.start + (ss.n - 1) * tau };
      const vars = { product: sim.depot.name || inn(drug.name), interval: interval(tau), tabs: days(tAbs),
        when: t90.dose <= 1 ? AP.t('pk.ssFirstInjection') : AP.t('pk.ssFromInjection', { k: t90.dose, tss: days(t90.t) }) };
      const initNote = initiationNote(sim, drug);
      if (sim.doseTimes.length < 2) { el.innerHTML = AP.t('pk.accumSingleDepot', vars) + initNote; return; }
      const items = steadyStateLevels(sim, drug).map(l => AP.t('pk.accumDepotItem', { color: l.color, name: l.name, css: `${AP.fmtAuto(AP.conc(l.css, l.mw))} ${unit()}` })).join('<br/>');
      el.innerHTML = `${AP.t('pk.accumDepotIntro', vars)}<br/>${items}${absLimited ? `<br/>${AP.t('pk.accumDepot', { tabs: AP.fmt(tAbs / 24) })}` : ''}${initNote}<br/>${convergenceNote(ss, drug)}`;
      return;
    }

    if (sim.doseTimes.length < 2) {
      const slow = Math.max(sim.params.t12, absLimited ? tAbs : 0, ...(sim.metabolites || []).map(m => m.t12));
      el.innerHTML = AP.t('pk.accumSingle', { drug: inn(drug.name), t12: days(slow), tss: days(4.5 * slow) });
      return;
    }

    const tau = sim.doseTimes[1] - sim.doseTimes[0];
    const lines = steadyStateLevels(sim, drug);
    const items = lines.map(l => AP.t('pk.accumItem', { color: l.color, name: l.name, t12: days(l.t12), r: AP.fmt(l.R, 1), t90: days(3.3 * l.t12) })).join('<br/>');
    const slowest = lines.reduce((a, b) => (b.t12 > a.t12 ? b : a), lines[0]);

    const dose = sim.params.auc * sim.params.CL / sim.params.F / 1000;
    el.innerHTML = `${AP.t('pk.accumIntro', { interval: interval(tau) })}<br/>${items}
      ${slowest && slowest.name !== drug.name ? `<br/>${AP.t('pk.accumMetabolite', { metabolite: slowest.name, t12: days(slowest.t12), drug: inn(drug.name) })}` : ''}
      <br/>${convergenceNote(steadyStateOf(drug, route, dose, tau, null), drug)}`;
  }

  /** Steady-state rows of the parameters table (D2-active level; concentrations of the moiety via its mass-weighted molar mass) */
  function steadyStateRows(sim, drug, route, row) {
    const tau = sim.doseTimes[1] - sim.doseTimes[0], dose = sim.params.auc * sim.params.CL / sim.params.F / 1000;
    const ss = steadyStateOf(drug, route, dose, tau, sim.initiation || null);
    const key = hasMoiety(drug) ? 'moiety' : 'parent', sp = ss.species[key];
    let mw = drug.mw;
    if (key === 'moiety') {   // mass sum → molar sum with each species' own molar mass
      const parts = [[ss.species.parent.cavg, drug.mw]].concat((drug.pk.metabolites || []).filter(m => m.d2).map(m => [(m.d2Weight ?? 1) * ss.species[m.key].cavg, m.mw]));
      mw = parts.reduce((a, [c]) => a + c, 0) / parts.reduce((a, [c, w]) => a + c / w, 0);
    }
    const c = (v) => `${AP.fmtAuto(AP.conc(v, mw))} ${unit()}`;
    const at = (x) => (x ? days(x.t) : '-');
    return `${row(AP.t('pk.p.ssRange', { analyte: analyteName(drug) }), `${c(sp.cmin)} - ${c(sp.cmax)}`)}
      ${row(AP.t('pk.p.css'), c(sp.cavg))}
      ${row(AP.t('pk.p.fluct'), `${AP.fmt(sp.fluctuation * 100)} %`)}
      ${sp.R ? row(AP.t('pk.p.r'), `${AP.fmt(sp.R, 2)}×`) : ''}
      ${row(AP.t('pk.p.t90'), `${at(ss.t90)} / ${at(ss.t95)} / ${at(ss.t99)}`)}`;
  }

  /** Derived PK parameters table */
  function renderParamsTable(sim, drug, route = 'oral') {
    const table = document.getElementById('pk-params');
    const notes = document.getElementById('pk-notes');
    if (!table) return;
    const p = sim.params;
    const t12Delta = p.t12 / drug.pk.t12;
    const c = (v, mw = drug.mw) => `${AP.fmtAuto(AP.conc(v, mw))} ${unit()}`;
    const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    const apparent = !!drug.pk.apparent && route === 'oral';

    table.innerHTML = `
      <tbody>
        ${row(AP.t('pk.p.route'), getRouteLabel(route))}
        ${sim.product && sim.product.name ? row(AP.t('pk.p.product'), sim.product.name) : ''}
        ${row(AP.t(sim.depot ? 'pk.p.cmaxDepot' : 'pk.p.cmax'), c(p.cmax))}
        ${row(AP.t(sim.depot ? 'pk.p.tmaxDepot' : 'pk.p.tmax'), p.tmax < 48 ? AP.t('pk.hours', { n: AP.fmt(p.tmax, 2) }) : AP.t('pk.days', { n: AP.fmt(p.tmax / 24, 1) }))}
        <tr><td>${AP.t('pk.p.t12')}</td><td>${days(p.t12)}${Math.abs(t12Delta - 1) > 0.05 ? ` <span class="delta ${t12Delta > 1 ? 'up' : 'down'}">(${t12Delta > 1 ? '+' : '−'}${AP.fmt(Math.abs(t12Delta - 1) * 100)} %)</span>` : ''}</td></tr>
        ${p.tAbs > p.t12 ? row(AP.t('pk.p.tabs'), `${days(p.tAbs)} ${AP.t('pk.p.rateLimiting')}`) : ''}
        ${row(AP.t('pk.p.vd'), `${AP.fmt(p.V)} L (${AP.fmtAuto(p.V / AP.numInput('pk-wt', 70))} L/kg)${apparent ? ' · V/F' : ''}`)}
        ${row(AP.t('pk.p.cl'), `${AP.fmt(p.CL, 2)} L/h${apparent ? ' · CL/F' : ''}`)}
        ${row(AP.t('pk.p.f'), apparent ? AP.t('pk.p.fApparent') : p.F > 1 ? AP.t('pk.p.fExposure', { f: AP.fmt(p.F, 2) }) : `${AP.fmt(p.F * 100)} %`)}
        ${row(AP.t('pk.p.auc'), `${AP.fmt(AP.conc(p.auc, drug.mw))} ${AP.aucUnit()}`)}
        ${sim.doseTimes.length > 1 ? steadyStateRows(sim, drug, route, row) : ''}
        ${(sim.metabolites || []).map(m => `
          <tr class="met-row">
            <td>${AP.t(m.d2 ? 'pk.p.metaboliteD2' : 'pk.p.metabolite', { color: m.color, name: m.name, t12: days(m.t12) })}</td>
            <td><span style="color:${m.color}">${m.cmax ? c(m.cmax, m.mw) : '-'}</span></td>
          </tr>`).join('')}
        ${(sim.components || []).map(m => `
          <tr class="met-row">
            <td>${AP.t('pk.p.component', { color: m.color, name: m.name, dose: AP.fmtAuto(m.dose), t12: days(m.t12) })}</td>
            <td><span style="color:${m.color}">${m.cmax ? c(m.cmax, m.mw) : '-'}</span></td>
          </tr>`).join('')}
      </tbody>
    `;

    if (notes) {
      const modText = [];
      if (sim.eff.clMult < 0.95) modText.push(AP.t('pk.clReduced', { pct: AP.fmt(sim.eff.clMult * 100) }));
      if (sim.eff.clMult > 1.05) modText.push(AP.t('pk.clIncreased', { pct: AP.fmt(sim.eff.clMult * 100) }));
      const pathways = Object.entries(drug.pk.pathways).map(([k, v]) => `${AP.t(`pk.pathway.${k}`)} ${AP.fmt(v * 100)} %`).join(', ');

      let routeNote = '';
      const ri = routeInfo(route);
      if (ri && route !== 'oral') routeNote = `<br/><b style="color:${ri.badgeColor}">${ri.name}:</b> ${ri.advantages}. <span class="lim">${AP.t('pk.limitations')}</span> ${ri.limitations}.`;
      if (sim.product && sim.product.label) routeNote += `<br/><b>${sim.product.name || AP.t('pk.depotProduct')}:</b> ${sim.product.label}.`;
      routeNote += `<br/>${AP.t('pk.formulations', { drug: inn(drug.name), routes: getAllowedRoutes(drug).map(getRouteLabel).join(', ') })}`;

      const compNote = (sim.components || []).map(m => ' ' + AP.t('pk.componentNote', { name: m.name, dose: AP.fmtAuto(m.dose), t12: days(m.t12),
        pathways: Object.entries((drug.pk.components.find(x => x.key === m.key) || {}).pathways || {}).map(([k, v]) => `${AP.t(`pk.pathway.${k}`)} ${AP.fmt(v * 100)} %`).join(', ') })).join('');
      notes.innerHTML = `<p>${AP.t('pk.summary', { drug: inn(drug.name), t12: days(drug.pk.t12), pathways })}${compNote}
        ${modText.length ? AP.t('pk.modsApplied', { effects: modText.join(AP.t('pk.and')) }) : AP.t('pk.noMods')}
        ${routeNote}</p>`;
    }
  }

  /** Duration of exposure comparison across representative drugs (properties.json model.durationComparison) */
  function plotDurationComparison(weight, mods) {
    const target = document.getElementById('pk-plot-cmp');
    if (!target) return;
    const cmp = AP.model.durationComparison;
    const TEND = 24 * 14;

    const traces = cmp.map(cd => {
      const d = AP.drugs[cd.drug];
      const sim = Models.simulate({ drug: d, dose: cd.dose, route: 'oral', n: 1, tau: 24, weight, mods, tEnd: TEND });
      const peak = sim.params.moietyMax || 1;
      return {
        x: sim.t.map(t => t / 24), y: sim.moiety.map(v => (v / peak) * 100), type: 'scatter', mode: 'lines',
        name: AP.t('pk.cmpLegend', { drug: d.name, dose: AP.fmtAuto(cd.dose), t12: days(d.pk.t12) }),
        line: { color: d.color, width: 2.5 },
      };
    });

    Plotly.react(target, traces, {
      ...plotBase(),
      xaxis: { title: { text: AP.t('pk.cmpAxisX'), standoff: 8 }, automargin: true, range: [0, 14], gridcolor: '#f1f3f5' },
      yaxis: { title: { text: AP.t('pk.cmpAxisY') }, range: [0, 105], gridcolor: '#f1f3f5' },
      margin: { l: 55, r: 20, t: 25, b: 115 },
      showlegend: true, legend: { orientation: 'h', yanchor: 'top', y: -0.34, x: 0 },
    }, { responsive: true, displayModeBar: false });

    const summary = document.getElementById('pk-cmp-summary');
    if (summary) {
      const t50 = traces.map((tr, i) => {
        const iPk = tr.y.indexOf(Math.max(...tr.y));
        const k = tr.y.findIndex((v, j) => j > iPk && v <= 50);
        return { key: cmp[i].drug, t: k > 0 ? tr.x[k] : null };
      });
      const fmt = (e) => `<b style="color:${AP.drugs[e.key].color}">${AP.drugs[e.key].name}</b> ${e.t === null ? AP.t('pk.cmpOver14') : '≈ ' + days(e.t * 24)}`;
      summary.innerHTML = AP.t('pk.cmpSummary', { list: t50.map(fmt).join(' · '), mods: mods.length ? AP.t('pk.withMods') : '' });
    }
  }

  return { init, update, syncRouteOptions, getAllowedRoutes, applyRegimen };
})();
