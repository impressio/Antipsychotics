/* =====================================================================
 * models.js - Pharmacodynamic (D2 competition, signaling, receptor
 * occupancy) and pharmacokinetic models.
 * ===================================================================== */
window.Models = (function () {
  'use strict';
  const AP = window.AP;   // filled by AP.load() before any model function is called
  const LN2 = Math.LN2;
  /* Striatal D2 occupancy thresholds (PET) and generic route absorption: properties.json "model" */
  const thresh = () => AP.model.thresholds;

  /* ---------------- Pharmacodynamics ---------------- */

  /**
   * Kᵢ used by the model. A drug whose D2 Kᵢ is not determined but which has a PET-calibrated EC50 uses 1 nM:
   * free concentrations are then in D2-Kᵢ units, and D2 occupancy depends only on Cp/EC50.
   */
  const kiOf = (d, target) => {
    const ki = d.pd.ki[target];
    return ki === undefined && target === 'd2' && d.pd.ec50 ? 1 : ki;
  };
  const isNd = (d, target) => !!(d && d.pd.nd && d.pd.nd.includes(target));

  const ia = (drug, target) => (drug && drug.pd && drug.pd.ia && drug.pd.ia[target]) || 0;

  /**
   * Competition between drug (free concentration C, Ki) and dopamine (DA, K_DA) at D2, and the
   * resulting signaling (Gi activation, 0-1): bound dopamine signals fully, bound drug with its
   * intrinsic activity, and empty receptors not at all.
   * @returns {{occD, occDA, signal, base}} base = signaling with dopamine alone
   */
  function d2Site(drugKey, cNM, daNM) {
    const d = drugKey && drugKey !== 'none' ? AP.drugs[drugKey] : null;
    const xd = d && kiOf(d, 'd2') ? (cNM || 0) / kiOf(d, 'd2') : 0;
    const xa = (daNM || 0) / AP.DA.K;
    const den = 1 + xd + xa;
    return {
      occD: xd / den, occDA: xa / den,
      signal: (xa + ia(d, 'd2') * xd) / den,
      base: xa / (1 + xa),
    };
  }

  /** Fractional occupancy (0-1) of a target; D2 includes competition with dopamine */
  function occupancy(drugKey, target, cNM, daNM = AP.DA.TONIC) {
    const d = drugKey && drugKey !== 'none' ? AP.drugs[drugKey] : null;
    if (!d || !(cNM > 0)) return 0;
    const ki = kiOf(d, target);
    if (ki === undefined || ki >= AP.NB) return 0;
    const x = cNM / ki;
    return target === 'd2' ? x / (1 + x + (daNM || 0) / AP.DA.K) : x / (1 + x);
  }

  /** Functional D2 blockade: occupancy weighted by the signaling a partial agonist retains */
  const blockade = (drugKey, occD) => occD * (1 - ia(AP.drugs[drugKey], 'd2'));

  /** Probability-like curves (0-1) of response, prolactin elevation and EPS versus functional blockade */
  const logistic = (b, th, s = 0.035) => 1 / (1 + Math.exp(-(b - th) / s));
  const clinical = (b) => ({
    response: logistic(b, thresh().response - 0.05),
    prolactin: logistic(b, thresh().prolactin),
    eps: logistic(b, thresh().eps),
  });

  /**
   * Plasma concentration (ng/mL of the D2-active moiety) → free concentration (nM) in Ki units.
   * Calibrated to PET: at tonic dopamine, D2 occupancy = Cp / (Cp + EC50).
   * Drugs without D2 binding (no EC50) use the unbound plasma concentration.
   */
  function freeFromPlasma(drug, cp) {
    if (!drug.pd.ec50) return cp * drug.pk.fu * 1000 / drug.mw;   // no D2 binding: unbound plasma concentration (nM)
    const k = 1 + AP.DA.TONIC / AP.DA.K;
    return kiOf(drug, 'd2') * k * cp / drug.pd.ec50;
  }

  /**
   * Potency at a target: plasma concentration (ng/mL of the active moiety) giving 50 % occupancy.
   * D2 includes competition with tonic dopamine, so the D2 value equals the PET-calibrated EC50.
   * Infinity if the drug does not bind the target.
   */
  function plasmaEC50(drug, target) {
    const ki = kiOf(drug, target);
    if (ki == null || ki >= AP.NB) return Infinity;
    return ki * (target === 'd2' ? 1 + AP.DA.TONIC / AP.DA.K : 1) / freeFromPlasma(drug, 1);
  }

  /* ---------------- Pharmacokinetics ---------------- */

  function combineMods(active) {
    const m = { cyp1a2: 1, cyp2d6: 1, cyp3a4: 1, cyp2c19: 1, ugt: 1, renal: 1, other: 1 };
    (active || []).forEach(k => {
      const mod = AP.modifiers[k];
      if (mod) Object.entries(mod.m).forEach(([p, v]) => { m[p] *= v; });
    });
    return m;
  }

  const pathMult = (pathways, m) =>
    Object.entries(pathways).reduce((s, [p, w]) => s + w * (m[p] ?? 1), 0);

  /** Effective PK parameters after applying modifiers. */
  function effectivePK(drug, mods, weight) {
    const p = drug.pk;
    const m = combineMods(mods);
    const clMult = pathMult(p.pathways, m);
    // clearance from the base parameters (clKg, set at load), so a regional half-life keeps the calibrated exposure;
    // the volume then follows from clearance and half-life
    const CL0 = (p.clKg ?? (LN2 / p.t12) * p.vd) * weight;
    const V = p.clKg ? CL0 * p.t12 / LN2 : p.vd * weight;   // L
    const CL = CL0 * clMult;                          // L/h
    let F = p.F;
    if (p.highFirstPass) {                            // hepatic extraction scales with intrinsic CL
      F = 1 - Math.min(0.97, (1 - p.F) * clMult);
    }
    const metabolites = (p.metabolites || []).map(mm => {
      const CLm0 = (mm.clKg ?? (LN2 / mm.t12) * mm.vd) * weight;
      const Vm = mm.clKg ? CLm0 * mm.t12 / LN2 : mm.vd * weight;
      const CLm = CLm0 * pathMult(mm.pathways, m);
      return { key: mm.key, name: mm.name, mw: mm.mw, from: mm.from || 'parent', fm: mm.fm, d2: !!mm.d2, color: mm.color || '#e8590c', V: Vm, CL: CLm, k: CLm / Vm, t12: LN2 / (CLm / Vm) };
    });
    return { V, CL, ke: CL / V, ka: p.ka, F, t12: LN2 / (CL / V), clMult, metabolites };
  }

  /**
   * Products (formulations or brands) of a drug by a route, e.g. Risperdal Consta and Okedi for
   * long-acting injection or Seroquel and Seroquel XR orally. A product inherits the route values
   * (rt.<route>) and overrides them; marketed: false hides it in a region. A route without a product
   * list is one unnamed product.
   */
  function routeProducts(drug, route) {
    const rt = drug && drug.pk && drug.pk.rt && drug.pk.rt[route];
    if (!rt) return route === 'oral' || route === 'odt' || route === 'iv' || (AP.model.routeDefaults || {})[route] ? [{ key: '' }] : [];
    const { products, product, selected, ...base } = rt;
    if (!products) return [{ key: '', ...base }];
    return Object.entries(products).filter(([, p]) => p.marketed !== false).map(([key, p]) => ({ ...base, key, ...p }));
  }
  /** Product in use: the one selected in the interface, else the regional default, else the first marketed */
  function routeProduct(drug, route, key) {
    const list = routeProducts(drug, route);
    const rt = drug && drug.pk && drug.pk.rt && drug.pk.rt[route];
    if (key !== undefined && key !== null) return list.find(p => p.key === key) || null;
    return list.find(p => p.key === (rt && rt.selected)) || list.find(p => p.key === (rt && rt.product)) || list[0] || null;
  }
  function selectProduct(drug, route, key) {
    const rt = drug && drug.pk && drug.pk.rt && drug.pk.rt[route];
    if (rt) rt.selected = key;
  }
  /**
   * Available strengths (doses) of a product for the dose menu: [{mg, dose, tau}], mg as labeled
   * (e.g. mg paliperidone palmitate), dose in mg of the modeled drug, tau an optional usual interval (h).
   */
  function strengthsOf(product) {
    return ((product && product.strengths) || []).map(x => (typeof x === 'number' ? { mg: x, dose: x } : { ...x, dose: x.dose ?? x.mg }));
  }
  /** Strength matching a dose (and interval, when strengths differ only by it); may override release, F and initiations */
  function strengthFor(product, dose, tau) {
    const st = strengthsOf(product).filter(x => Math.abs(x.dose - dose) < 1e-6);
    return st.find(x => x.tau === tau) || st.find(x => !x.tau) || st[0] || null;
  }
  /**
   * Initiation (loading) regimens of a product for a maintenance dose: {key: {type, start_d, items}};
   * start_d: day of the first maintenance injection; items: loading injections (at_d, or every_h × count),
   * other products (product) or release profiles (release, F, name), and oral overlap (route oral, for_d days
   * at the usual oral regimen unless dose and every_h are given).
   */
  function initiationsFor(product, dose, tau) {
    const st = strengthFor(product, dose, tau);
    return (st && st.initiations) || (product && product.initiations) || {};
  }

  /**
   * Absorption parameters for a drug by a given route. IV: F = 1. Oral: the drug's F after
   * modifiers (high-first-pass drugs change with hepatic function). Other routes: drug-specific
   * values (orodispersible tablets fall back to oral), else generic route defaults.
   * phases: release phases of the dose [{f, lag (h), dur (h), ka (1/h)}]; a phase releases its
   * fraction f after the lag, at once (dur 0) or at a constant rate over dur, into its own
   * first-order absorption compartment (ka 0: straight into plasma).
   */
  function routeAbsorption(drug, route, e, o = {}) {
    if (route === 'iv') return { F: 1.0, ka: 0, tlag: 0, phases: [{ f: 1, lag: 0, dur: 0, ka: 0 }], tAbs: 0, releaseEnd: 0 };
    let prod = o.override ? { ...routeProduct(drug, route, o.key), ...o.override } : routeProduct(drug, route, o.key);
    // a strength with its own formulation (e.g. the 2-monthly 720/960 mg) overrides release and F
    const st = !o.override && o.dose !== undefined ? strengthFor(prod, o.dose, o.tau) : null;
    if (st && (st.release || st.F !== undefined)) prod = { ...prod, ...(st.release ? { release: st.release } : {}), ...(st.F !== undefined ? { F: st.F } : {}) };
    // oral products keep the drug's (modifier-dependent) F, scaled by Frel, with their own absorption rate
    const rp = route === 'oral' ? null : (prod && prod.F !== undefined ? prod : AP.model.routeDefaults[route]);
    const r = rp ? { F: rp.F, ka: rp.ka, tlag: rp.tlag || 0 }
      : { F: e.F * ((prod && prod.Frel) ?? 1), ka: (prod && prod.ka) ?? e.ka, tlag: 0 };
    r.phases = rp && rp.release ? rp.release : [{ f: 1, lag: r.tlag, dur: 0, ka: r.ka || 0 }];
    // rate-limiting release half-life (h): the slowest phase carrying most of the dose
    const main = r.phases.reduce((a, b) => (b.f > a.f ? b : a), r.phases[0]);
    r.tAbs = main.ka > 0 ? LN2 / main.ka : 0;
    r.releaseEnd = Math.max(...r.phases.map(p => p.lag + p.dur));
    return r;
  }

  /** Systemic bioavailability (0-1) used by the PK model for a drug, route and modifiers */
  function bioavailability(drug, route, mods) {
    if (!drug || !drug.pk) return null;
    return routeAbsorption(drug, route, effectivePK(drug, mods || [], 70)).F;
  }

  /** Usual dose (mg) and dosing interval (h) of a drug for a route, from the selected product */
  function regimenFor(drug, route) {
    const rp = routeProduct(drug, route);
    return { dose: (rp && rp.dose) || drug.pk.dose, tau: (rp && rp.tau) || drug.pk.tau, label: rp && rp.label, product: rp };
  }

  /**
   * One-compartment model with first-order elimination, metabolites formed from the parent (or from
   * another metabolite) and absorption through the release phases of the route (RK4 integration).
   * Dose times are the administration (injection) times; release lags are part of the phases.
   */
  function simulate(opts) {
    const { drug, dose, route, n, tau, weight, mods } = opts;
    const e = effectivePK(drug, mods, weight);
    const abs = routeAbsorption(drug, route, e, { key: opts.productKey, override: opts.override, dose, tau });
    const routeF = abs.F, P = abs.phases;
    // initiation regimen: maintenance starts at start_d, loading doses and oral overlap are simulated separately
    const init = opts.initiation || null;
    const start = init ? (init.start_d || 0) * 24 : 0;
    const doseTimes = opts.times || Array.from({ length: n }, (_, i) => start + i * tau);
    const lastDose = Math.max(...doseTimes);
    const tAbs = abs.tAbs;                            // release half-life (depots: weeks)
    const maxT12 = Math.max(e.t12, ...P.map(p => (p.ka > 0 ? LN2 / p.ka : 0)), ...e.metabolites.map(m => m.t12));
    const tEnd = opts.tEnd ?? Math.min(lastDose + 24 * 400, Math.max(24, lastDose + abs.releaseEnd + Math.min(5 * maxT12, 24 * 120), lastDose + 24));

    const M = e.metabolites;
    const src = M.map(m => (m.from === 'parent' ? -1 : M.findIndex(x => x.key === m.from)));
    const kmax = Math.max(...P.map(p => p.ka), e.ke, ...M.map(m => m.k));
    const dt = Math.min(0.05, 0.15 / kmax, tEnd / 4000);

    const Fused = route === 'iv' ? 1.0 : routeF;
    // state: [release compartment per phase, central, metabolites...]
    const nP = P.length, iC = nP, nS = nP + 1 + M.length;
    // zero-order release: rate (mg/h) of each phase at time t from all doses
    const zeroRate = (p, t) => {
      if (!(p.dur > 0)) return 0;
      let r = 0;
      for (const td of doseTimes) { const s = t - td - p.lag; if (s >= 0 && s < p.dur) r += p.f * Fused * dose / p.dur; }
      return r;
    };
    let A = new Float64Array(nS);
    const deriv = (y, t) => {
      const d = new Float64Array(nS);
      P.forEach((p, j) => {
        const r = zeroRate(p, t);
        if (p.ka > 0) { d[j] = r - p.ka * y[j]; d[iC] += p.ka * y[j]; } else d[iC] += r;
      });
      d[iC] -= e.ke * y[iC];
      M.forEach((m, i) => {
        const fromRate = src[i] < 0 ? e.ke * y[iC] : M[src[i]].k * y[iC + 1 + src[i]];
        d[iC + 1 + i] = m.fm * fromRate - m.k * y[iC + 1 + i];
      });
      return d;
    };
    const axpy = (y, k, h) => y.map((v, i) => v + h * k[i]);
    // bolus releases (dur 0): [time, phase]
    const boluses = doseTimes.flatMap(td => P.map((p, j) => [td + p.lag, j]).filter(([, j]) => !(P[j].dur > 0))).sort((a, b) => a[0] - b[0]);

    const T = [], Cp = [];
    const curves = M.map(m => ({ key: m.key, name: m.name, mw: m.mw, color: m.color, t12: m.t12, V: m.V, CL: m.CL, d2: m.d2, cp: [] }));
    const steps = Math.ceil(tEnd / dt);
    const every = Math.max(1, Math.floor(steps / 1500));
    let bi = 0;
    for (let s = 0; s <= steps; s++) {
      const t = s * dt;
      while (bi < boluses.length && boluses[bi][0] <= t + 1e-9) {
        const j = boluses[bi][1], amt = P[j].f * Fused * dose;
        if (P[j].ka > 0) A[j] += amt; else A[iC] += amt;
        bi++;
      }
      if (s % every === 0) {
        T.push(+t.toFixed(4));
        Cp.push((A[iC] / e.V) * 1000);
        curves.forEach((c, i) => c.cp.push((A[iC + 1 + i] / M[i].V) * 1000));
      }
      const k1 = deriv(A, t), k2 = deriv(axpy(A, k1, dt / 2), t + dt / 2), k3 = deriv(axpy(A, k2, dt / 2), t + dt / 2), k4 = deriv(axpy(A, k3, dt), t + dt);
      A = A.map((v, i) => v + dt / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    }

    // initiation: each loading or overlap item simulated on its own and added (linear kinetics)
    const extras = init ? (init.items || []).map(it => {
      const r = it.route || route;
      const oral = r === 'oral' ? regimenFor(drug, 'oral') : null;
      const every = it.every_h || (oral ? oral.tau : tau);
      const times = it.at_d ? it.at_d.map(d => d * 24)
        : Array.from({ length: it.count || Math.max(1, Math.round((it.for_d || 0) * 24 / every)) }, (_, i) => (it.from_d || 0) * 24 + i * every);
      const d = it.dose ?? (oral ? oral.dose : dose);
      const sub = simulate({ drug, dose: d, route: r, n: times.length, times, tau: every, weight, mods, tEnd, single: true,
        productKey: it.product, override: it.release ? { release: it.release, F: it.F ?? abs.F, name: it.name } : null });
      const at = (series) => { let j = 0; return T.map(t => {
        while (j < sub.t.length - 2 && sub.t[j + 1] < t) j++;
        const t0 = sub.t[j], t1 = sub.t[j + 1] ?? t0, f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
        return series[j] + f * ((series[j + 1] ?? series[j]) - series[j]);
      }); };
      at(sub.cp).forEach((v, i) => { Cp[i] += v; });
      curves.forEach((c, k) => at(sub.metabolites[k].cp).forEach((v, i) => { c.cp[i] += v; }));
      const prod = r === 'oral' ? null : routeProduct(drug, r, it.product);
      const mg = it.mg ?? ((strengthFor(prod, d) || {}).mg) ?? d;   // labeled strength (e.g. mg palmitate)
      return { route: r, times, dose: d, mg, name: it.name || (it.product ? (prod || {}).name : null) };
    }) : [];

    // Cmax/Tmax of the first dose (depots: from a single-dose run, as release outlasts the interval)
    let cmax = 0, tmax = 0;
    if (route === 'lai' && n > 1 && !opts.single) {
      const one = simulate({ ...opts, n: 1, times: undefined, initiation: null, tEnd: undefined, single: true });
      cmax = one.params.cmax; tmax = one.params.tmax;
    } else {
      const firstEnd = n > 1 ? doseTimes[0] + tau : tEnd;
      for (let i = 0; i < T.length && T[i] <= firstEnd; i++) if (Cp[i] > cmax) { cmax = Cp[i]; tmax = T[i] - doseTimes[0]; }
    }
    const cmaxAll = Math.max(0, ...Cp);
    curves.forEach(c => { c.cmax = Math.max(0, ...c.cp); });
    // D2-active moiety: parent + metabolites flagged as D2-active
    const moiety = Cp.map((c, i) => c + curves.reduce((s, m) => s + (m.d2 ? m.cp[i] : 0), 0));

    const params = {
      cmax, tmax, cmaxAll, moietyMax: Math.max(0, ...moiety),
      auc: Fused * dose / e.CL * 1000,
      t12: e.t12, tAbs, releaseEnd: abs.releaseEnd, V: e.V, CL: e.CL, F: Fused, ke: e.ke,
      ka: route === 'iv' ? null : (abs.tAbs ? LN2 / abs.tAbs : abs.ka),
      R: n > 1 ? 1 / (1 - Math.exp(-e.ke * tau)) : 1,
      cssAvg: n > 1 ? Fused * dose / (e.CL * tau) * 1000 : null,
      metabolites: curves,
    };
    const components = (drug.pk.components || []).map(c => simulateComponent(c, opts, tEnd, T));
    const product = routeProduct(drug, route, opts.productKey);
    return { t: T, cp: Cp, moiety, params, doseTimes, extras, start, tEnd, eff: e, metabolites: curves, components, product, depot: route === 'lai' ? product : null };
  }

  /** Dose (mg) of a co-formulated compound: from the capsule strength nearest the parent dose */
  function componentDose(comp, dose) {
    const s = comp.strengths || [];
    if (!s.length) return 0;
    return s.reduce((best, x) => (Math.abs(x[0] - dose) < Math.abs(best[0] - dose) ? x : best), s[0])[1];
  }

  /** Co-formulated compound (own PK, same regimen), resampled onto the parent's time grid */
  function simulateComponent(comp, opts, tEnd, T) {
    const dose = componentDose(comp, opts.dose);
    const sim = simulate({ ...opts, drug: { pk: comp }, dose, tEnd });
    let j = 0;
    const cp = T.map(t => {
      while (j < sim.t.length - 2 && sim.t[j + 1] < t) j++;
      const t0 = sim.t[j], t1 = sim.t[j + 1] ?? t0, f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
      return sim.cp[j] + f * ((sim.cp[j + 1] ?? sim.cp[j]) - sim.cp[j]);
    });
    return { key: comp.key, name: comp.name, mw: comp.mw, color: comp.color, dose, t12: sim.params.t12, cmax: Math.max(0, ...cp), tmax: sim.params.tmax, cssAvg: sim.params.cssAvg, cp };
  }

  return { d2Site, occupancy, isNd, blockade, clinical, freeFromPlasma, plasmaEC50, effectivePK, simulate, bioavailability, regimenFor, routeAbsorption, routeProducts, routeProduct, selectProduct, strengthsOf, strengthFor, initiationsFor, ia, get THRESH() { return thresh(); } };
})();
