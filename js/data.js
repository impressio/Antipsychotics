/* =====================================================================
 * data.js - Loads the app's domain data.
 *
 * All drug, molecular, receptor, route, regional and model data live in
 * assets/data/properties.json, the single source to correct them (units are
 * documented in its "meta" section). AP.load() fetches that file once and
 * exposes its content on window.AP before the app starts (see js/main.js):
 * targets, otherTargets, dopaminePathways, drugs, dopamine, routes, drugRoutes,
 * metabolism, modifiers, regions, model, substancesTable, references and
 * sources (the literature behind each value) and validation (observed data
 * for the PK model).
 *
 * Settings (URL ?lang=sv&region=eu, remembered in localStorage; defaults from the browser locale,
 * see below; language and region are switched independently):
 *  - language: interface texts from assets/i18n/<lang>.json (AP.t); its "data"
 *    section translates descriptive texts of properties.json by path;
 *  - region: "us" (base data: FDA labels, US brands, ng/mL), "eu" (values that
 *    differ in EU SmPCs as published in FASS, Swedish product names, µg/L) or
 *    "se" (the EU values with plasma concentrations in nmol/L), merged from
 *    properties.json "jurisdictions" over the base data.
 * AP.raw keeps the unmodified file (sources, validation and calibration refer to it).
 * ===================================================================== */
window.AP = (function () {
  'use strict';

  const NB = 1e5; // nM: stands for "no appreciable binding" (null Ki in the data file)

  const AP = { NB, load };

  /** One label format for every target selector */
  AP.targetLabel = (k) => AP.t('target.selectLabel', { label: AP.targets[k].label, family: AP.targets[k].family });

  /** Plot font from the CSS typography tokens (TYPOGRAPHY.md): Inter stack, --fs-small (12px), --ink */
  AP.plotFont = (extra) => {
    const css = getComputedStyle(document.documentElement), v = (k) => css.getPropertyValue(k).trim();
    return { family: v('--font') || 'Inter, sans-serif', size: parseFloat(v('--fs-small')) || 12, color: v('--ink') || '#1e1e1e', ...extra };
  };

  /** Plot hover boxes: white with a light border, so the dark text stays readable whatever the trace color */
  AP.plotHover = () => ({ bgcolor: '#ffffff', bordercolor: '#ced4da', font: AP.plotFont() });

  /* ---------- Settings: language and region ---------- */
  const LANGS = ['en', 'sv'], REGIONS = ['us', 'eu', 'se'];
  const STORE = 'ap-';   // localStorage prefix, distinct from the companion app served from the same origin
  const pick = (name, allowed, fallback) => {
    const q = new URLSearchParams(location.search).get(name);
    let v = allowed.includes(q) ? q : null;
    try { if (v) localStorage.setItem(STORE + name, v); else v = localStorage.getItem(STORE + name); } catch (e) { /* storage unavailable */ }
    return allowed.includes(v) ? v : fallback;
  };
  // Defaults from the browser's preferred locale: Swedish (sv, or a Swedish locale such as en-SE) → Swedish
  // with SE units; another European country or language (en-GB, de, fi-FI, ...) → English with EU units;
  // everything else (en-US, non-European locales) → English with US units. Language and region can then
  // be changed in the settings menu (or with ?lang= and ?region= in the URL): changing the language also
  // selects its values and units (Swedish → SE), and the region can then be changed on its own.
  const browserLangs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en']).map(l => String(l).split(';')[0].trim().toLowerCase());
  const EUROPE = ['at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'de', 'gr', 'hu', 'ie', 'it', 'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se', 'no', 'is', 'li', 'ch', 'gb', 'uk'];
  const EUROPEAN_LANGS = ['bg', 'hr', 'cs', 'da', 'nl', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'ga', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'nb', 'nn', 'no', 'is', 'lb', 'ca', 'eu', 'gl', 'cy'];
  const [bLang, bCountry] = browserLangs[0].split('-');
  const browserRegion = (bLang === 'sv' || bCountry === 'se') ? 'se'
    : (bCountry ? EUROPE.includes(bCountry) : EUROPEAN_LANGS.includes(bLang)) ? 'eu' : 'us';
  /** Values and units for a language: Swedish → SE; English → EU for European locales, otherwise US */
  const defaultRegion = (lang) => (lang === 'sv' ? 'se' : browserRegion === 'us' ? 'us' : 'eu');
  AP.lang = pick('lang', LANGS, browserRegion === 'se' ? 'sv' : 'en');
  AP.region = pick('region', REGIONS, defaultRegion(AP.lang));
  document.documentElement.lang = AP.lang;
  /** Reload with a changed setting (all modules start from the data again). Changing the language also
   *  selects that language's regional values and units; the region can then be changed on its own. */
  AP.setSetting = (name, value) => {
    const set = { [name]: value };
    if (name === 'lang') set.region = defaultRegion(value);
    const u = new URL(location.href);
    Object.entries(set).forEach(([k, v]) => {
      try { localStorage.setItem(STORE + k, v); } catch (e) { /* storage unavailable */ }
      u.searchParams.set(k, v);
    });
    location.href = u.toString();
  };

  /* ---------- Interface texts ---------- */
  let ui = {}, uiEn = {};
  /** Interface text by key, with {name} placeholders filled from vars; falls back to English, then the key */
  AP.t = (key, vars) => {
    const s = ui[key] ?? uiEn[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s;
  };
  /** Number in the interface language (decimal comma in Swedish); d = fixed decimals */
  AP.fmt = (x, d = 0) => (x === null || x === undefined || Number.isNaN(+x) ? '-'
    : new Intl.NumberFormat(AP.lang === 'sv' ? 'sv-SE' : 'en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }).format(+x));
  /** Number with a sensible precision for its size (≥ 100: none, ≥ 10: one if fractional, < 10: up to two) */
  AP.fmtAuto = (x) => {
    const a = Math.abs(+x);
    return AP.fmt(x, a >= 100 ? 0 : a >= 10 ? (Number.isInteger(+x) ? 0 : 1) : a >= 1 ? 1 : 2);
  };
  /**
   * Numeric value of an <input type="number">, limited to its min/max attributes (and rounded if
   * int); empty or non-numeric input gives the fallback. Every model input is read through this.
   */
  AP.numInput = (id, fallback, int = false) => {
    const el = document.getElementById(id);
    let v = el ? parseFloat(el.value) : NaN;
    if (!Number.isFinite(v)) return fallback;
    if (int) v = Math.round(v);
    const lo = parseFloat(el.min), hi = parseFloat(el.max);
    if (Number.isFinite(lo)) v = Math.max(lo, v);
    if (Number.isFinite(hi)) v = Math.min(hi, v);
    return v;
  };
  // Number fields never show a value outside their min/max: above max at once, below min when the edit is done
  // (capture phase, so the corrected value is what every section reads)
  const clampField = (e, low) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== 'number' || el.value === '') return;
    const v = parseFloat(el.value), lo = parseFloat(el.min), hi = parseFloat(el.max);
    if (Number.isFinite(hi) && v > hi) el.value = hi;
    else if (low && Number.isFinite(lo) && v < lo) el.value = lo;
  };
  document.addEventListener('input', (e) => clampField(e, false), true);
  document.addEventListener('change', (e) => clampField(e, true), true);
  /** Plotly decimal and thousands separators for the interface language */
  AP.plotSeparators = () => (AP.lang === 'sv' ? ', ' : '.,');
  /** Plasma concentration unit of the selected region (ng/mL and µg/L are numerically equal; SE uses nmol/L) */
  AP.concUnit = () => (AP.jurisdiction && AP.jurisdiction.concentrationUnit) || 'ng/mL';
  AP.molar = () => AP.concUnit() === 'nmol/L';
  /** A plasma concentration stored in ng/mL, in the unit of the selected region (mw in g/mol for molar units) */
  AP.conc = (ngPerMl, mw) => (AP.molar() && mw ? ngPerMl * 1000 / mw : ngPerMl);
  /** Unit of an area under the curve (concentration × time) */
  AP.aucUnit = () => ({ 'µg/L': 'µg·h/L', 'nmol/L': 'nmol·h/L' }[AP.concUnit()] || 'ng·h/mL');

  /** Translate static page text: [data-i18n] (inner HTML) and [data-i18n-<attribute>] */
  AP.translatePage = (root = document) => {
    root.querySelectorAll('[data-i18n]').forEach(el => { const s = AP.t(el.dataset.i18n); if (s !== el.dataset.i18n) el.innerHTML = s; });
    ['placeholder', 'title', 'aria-label', 'alt'].forEach(a => root.querySelectorAll(`[data-i18n-${a}]`).forEach(el => {
      const k = el.getAttribute(`data-i18n-${a}`), s = AP.t(k); if (s !== k) el.setAttribute(a, s);
    }));
    root.querySelectorAll('[data-setting]').forEach(b => b.setAttribute('aria-pressed', String(AP[b.dataset.setting] === b.dataset.value)));
    const tog = root.getElementById ? root.getElementById('settings-toggle') : null;
    if (tog) tog.textContent = `${AP.lang.toUpperCase()} · ${AP.region.toUpperCase()}`;
  };

  /** Settings panel in the top bar (both pages): language and region, applied by reloading */
  AP.initSettings = () => {
    const tog = document.getElementById('settings-toggle'), panel = document.getElementById('settings-panel');
    if (!tog || !panel) return;
    const show = (open) => { panel.hidden = !open; tog.setAttribute('aria-expanded', String(open)); };
    tog.addEventListener('click', (e) => { e.stopPropagation(); show(panel.hidden); });
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-setting]'); if (!b) return;
      if (AP[b.dataset.setting] !== b.dataset.value) AP.setSetting(b.dataset.setting, b.dataset.value); else show(false);
    });
    document.addEventListener('click', (e) => { if (!panel.hidden && !e.target.closest('.settings')) show(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') show(false); });
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  /** Deep merge of an overlay into data (objects by key, arrays by index) */
  const merge = (base, over) => {
    Object.entries(over || {}).forEach(([k, v]) => {
      const key = Array.isArray(base) ? +k : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && base[key] && typeof base[key] === 'object') merge(base[key], v);
      else base[key] = clone(v);
    });
    return base;
  };
  /** Set a value by path ("drugs.haloperidol.use", array indexes allowed) */
  const setPath = (o, path, v) => {
    const ks = path.split('.'); let x = o;
    for (let i = 0; i < ks.length - 1; i++) { x = x?.[Array.isArray(x) ? +ks[i] : ks[i]]; if (!x) return; }
    const last = ks[ks.length - 1]; if (x && (Array.isArray(x) ? +last : last) in x) x[Array.isArray(x) ? +last : last] = v;
  };
  /** Model-ready drug data: null Ki → NB, "nd" Ki left out; depot absorption half-lives and release phases (days) → hours and ka (1/h) */
  const prepareDrugs = (drugs) => Object.values(drugs).forEach(d => {
    // null → NB (no appreciable binding); "nd" (not determined) → key left out and listed in pd.nd
    const nb = (ki) => Object.fromEntries(Object.entries(ki).filter(([, x]) => x !== 'nd').map(([s, x]) => [s, x === null ? NB : x]));
    d.pd.nd = Object.keys(d.pd.ki).filter(s => d.pd.ki[s] === 'nd');
    d.pd.ki = nb(d.pd.ki);
    (d.pd.components || []).forEach(c => { c.ki = nb(c.ki); });
    // routes, products, strengths and initiation items: absorption half-lives and release phases (days) → hours and ka
    const walk = (o) => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (!o || typeof o !== 'object') return;
      if (o.tAbs_d) o.ka = Math.LN2 / (o.tAbs_d * 24);
      (o.release || []).forEach(p => Object.assign(p, { lag: (p.lag_d || 0) * 24, dur: (p.dur_d || 0) * 24, ka: p.tAbs_d ? Math.LN2 / (p.tAbs_d * 24) : 0 }));
      Object.entries(o).forEach(([k, v]) => { if (k !== 'release') walk(v); });
    };
    walk((d.pk && d.pk.rt) || {});
  });

  /**
   * Model-ready data of a region: translations (paths into the base data or into jurisdictions.<region>.data),
   * then the region overlay (SE inherits EU), clearance kept from the base parameters and drugs prepared.
   * Used by AP.load() and, for each region, by the validation table and tests/pk.test.mjs.
   */
  AP.regionData = (raw, region, translations) => {
    const p = clone(raw);
    Object.entries(translations || {}).forEach(([path, v]) => setPath(p, path, v));
    const j = (p.jurisdictions || {})[region] || null;
    const parent = j && j.inherits ? p.jurisdictions[j.inherits] : null;
    if (parent) merge(p, parent.data);                       // e.g. SE: EU values with Swedish units
    if (j) merge(p, j.data);
    // clearance per kg from the base (calibrated) parameters: regional half-lives change the curve shape, not the exposure
    const clKg = (pk) => Math.LN2 / pk.t12 * pk.vd;
    Object.entries(raw.drugs).forEach(([k, b]) => {
      const pk = p.drugs[k] && p.drugs[k].pk;
      if (!pk || !b.pk) return;
      pk.clKg = clKg(b.pk);
      (pk.metabolites || []).forEach((m, i) => { if (b.pk.metabolites && b.pk.metabolites[i]) m.clKg = clKg(b.pk.metabolites[i]); });
    });
    prepareDrugs(p.drugs);
    return p;
  };

  let loading = null;
  function load() {
    if (loading) return loading;
    loading = (async () => {
      if (location.protocol === 'file:') {
        throw new Error('the data file needs a web server: run "python3 -m http.server" in the project folder and open http://localhost:8000');
      }
      const res = await fetch('assets/data/properties.json');
      if (!res.ok) throw new Error(`could not load assets/data/properties.json (HTTP ${res.status})`);
      const raw = await res.json();
      const [en, tr] = await Promise.all(['en', AP.lang].map(async (l, i) => {
        if (i === 1 && l === 'en') return null;
        const r = await fetch(`assets/i18n/${l}.json`);
        return r.ok ? r.json() : {};
      }));
      uiEn = en.ui || {}; ui = (tr || en).ui || {};
      const p = AP.regionData(raw, AP.region, tr && tr.data);
      AP.jurisdiction = (p.jurisdictions || {})[AP.region] || null;
      AP.baseDrugs = clone(raw.drugs); prepareDrugs(AP.baseDrugs);
      AP.raw = raw;
      Object.assign(AP, {
        targets: p.targets,
        otherTargets: p.otherTargets,
        pathways: p.dopaminePathways,
        drugs: p.drugs,
        chemGroups: p.chemGroups || [],
        dopamine: p.dopamine,
        routes: p.routes,
        drugRoutes: p.drugRoutes,
        metabolism: p.metabolism,
        modifiers: p.modifiers,
        regions: p.regions,
        model: p.model,
        DA: { K: p.model.dopamine.K_nM, TONIC: p.model.dopamine.tonic_nM },
        substancesTable: p.substances,
        references: p.references,
        sources: p.sources,
        validation: p.validation,
      });
      return p;
    })();
    return loading;
  }

  return AP;
})();
