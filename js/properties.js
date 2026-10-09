/* =====================================================================
 * properties.js - Searchable, filterable tables of every numeric property
 * in assets/data/properties.json (loaded through AP.load(), as in the app),
 * with the source and verification status of each value and a validation
 * of the pharmacokinetic model against the observed data.
 * ===================================================================== */
(function () {
  'use strict';

  const ROUTE_NAMES = new Proxy({}, { get: (o, k) => AP.t(`route.${String(k)}`) });
  const PATHWAYS = new Proxy({ cyp1a2: 'CYP1A2', cyp2d6: 'CYP2D6', cyp3a4: 'CYP3A4', cyp2c19: 'CYP2C19', ugt: 'UGT' },
    { get: (o, k) => o[k] || (k === 'renal' ? AP.t('pt.renal') : k === 'other' ? AP.t('pt.other') : undefined) });

  const esc = (v) => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /** Decimal comma in Swedish for numbers and numeric text cells */
  const loc = (s) => (AP.lang === 'sv' ? String(s).replace(/(\d)\.(\d)/g, '$1,$2') : String(s));
  const num = (v) => (v === null || v === undefined || v === '' ? '-' : loc(v));
  /* Units belong in the column titles: cells show numbers only */
  const pctN = (v) => (v === null || v === undefined ? '-' : String(Math.round(v * 100)));
  const pathsN = (o) => (o ? Object.entries(o).map(([k, v]) => `${PATHWAYS[k] || k} ${Math.round(v * 100)}`).join(', ') : '-');
  const headCell = (h) => (Array.isArray(h) ? `${h[0]}<br><span class="props-unit">(${h[1]})</span>` : h);
  const sig = (x) => { if (typeof x !== 'number') return String(x); const n = +x.toPrecision(x >= 100 ? 3 : 2); return AP.fmt(n, (String(n).split('.')[1] || '').length); };

  const STATUS = new Proxy({}, { get: (o, k) => [AP.t(`status.${k}`), AP.t(`status.${k}.tip`)] });
  const getPath = (o, path) => path.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
  const show = (v) => (v === null || v === undefined ? '-' : Array.isArray(v) ? v.join('-') : typeof v === 'object'
    ? Object.entries(v).map(([k, x]) => `${k} ${x === null ? AP.t('pt.notBound') : x}`).join(', ') : String(v));
  const cite = (r) => `${esc(r.authors)}${r.authors.endsWith('.') ? '' : '.'} ${esc(r.title)}. <i>${esc(r.journal)}</i> ${r.year}${r.volume ? `;${esc(r.volume)}` : ''}${r.pages ? `:${esc(r.pages)}` : ''}.`;
  const urlLabel = (u) => (/dailymed\./.test(u) ? 'DailyMed' : /fass\.se/.test(u) ? 'FASS' : AP.t('pt.web'));
  const refLinks = (r) => [r.pmid && `<a href="https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/" target="_blank" rel="noopener">PubMed ${r.pmid}</a>`,
    r.doi && `<a href="https://doi.org/${esc(r.doi)}" target="_blank" rel="noopener">DOI</a>`,
    r.url && r.url !== `https://doi.org/${r.doi}` && `<a href="${esc(r.url)}" target="_blank" rel="noopener">${urlLabel(r.url)}</a>`].filter(Boolean).join(' · ');
  const refShort = (P, id) => {
    const r = P.references[id];
    if (!r) return esc(id);
    const label = r.setid ? AP.t('pt.fdaLabel', { p: r.title.split(':')[0] }) : r.url && /fass/.test(r.url) ? AP.t('pt.fass', { p: r.title.split(' (')[0] }) : r.authors.split(',')[0];
    return `<a href="#ref-${id}">${esc(label)} ${r.year}</a>`;
  };

  /* ---------- Pharmacokinetic model validation ---------- */
  /**
   * Each observed case simulated as in the source (70 kg reference adult, no modifiers; the product's region data,
   * US by default) by Models.validateCase: one row per endpoint, concentrations in the region unit of the analyte.
   */
  const regionDrugs = {};
  function validationRows(B) {
    return (B.validation || []).flatMap(v => {
      const region = v.region || 'us';
      const drugs = regionDrugs[region] || (regionDrugs[region] = AP.regionData(AP.raw, region).drugs);
      const drug = drugs[v.drug];
      const analyte = v.analyte || 'parent';
      const met = (drug.pk.metabolites || []).find(m => m.key === analyte);
      const mw = met ? met.mw : drug.mw;
      const product = window.Models.routeProduct(drug, v.route, v.product);
      return window.Models.validateCase(v, drug).map(e => {
        const conc = (x) => (e.kind === 'concentration' && x !== null ? AP.conc(x, mw) : x);
        return { v, e, drug, product, analyteName: met ? met.name : analyte === 'moiety' ? AP.t('pt.v.moiety') : drug.name,
          obs: Array.isArray(e.obs) ? e.obs.map(conc) : conc(e.obs), obsMid: conc(e.obsMid), pred: conc(e.pred) };
      });
    });
  }
  const unitOf = (kind) => (kind === 'concentration' ? AP.concUnit() : kind === 'time' ? 'h' : kind === 'doses' ? AP.t('pt.v.doses') : '');
  const statusCell = (r) => {
    if (r.e.pass === null) return '-';
    const rel = r.e.kind === 'doses' ? `${r.e.rel > 0 ? '+' : ''}${AP.fmt(r.e.rel)}` : AP.fmt(r.e.rel, 2);
    return `<span class="props-status props-status-${r.e.pass ? 'consistent' : 'differs'}" title="${AP.t(r.e.pass ? 'pt.v.within' : 'pt.v.outside')}">${rel}</span>`;
  };
  const obsText = (v) => (v === null || v === undefined ? '-' : Array.isArray(v) ? `${sig(v[0])}-${sig(v[1])}` : sig(v));

  function drawValidation(B, rows) {
    const el = document.getElementById('val-plot');
    if (!el || !window.Plotly) return;
    const traces = [], lines = [], seen = new Set();
    const panel = (kind, axis, unit, lo, hi, band) => {
      const pts = rows.filter(r => r.e.kind === kind && r.pred !== null);
      [1, band[0], band[1]].forEach(f => lines.push({ x: [lo, hi], y: [lo * f, hi * f], xaxis: axis.x, yaxis: axis.y, mode: 'lines', hoverinfo: 'skip', showlegend: false,
        line: { color: f === 1 ? '#868e96' : '#ced4da', width: 1, dash: f === 1 ? 'solid' : 'dash' } }));
      pts.forEach(r => {
        const d = B.drugs[r.v.drug], first = !seen.has(r.v.drug); seen.add(r.v.drug);
        const range = Array.isArray(r.obs) ? r.obs : null;
        traces.push({ x: [r.obsMid], y: [r.pred], xaxis: axis.x, yaxis: axis.y, mode: 'markers', name: d.name, legendgroup: r.v.drug, showlegend: first,
          marker: { size: 9, color: d.color, symbol: r.v.set === 'validation' ? 'circle' : 'circle-open', line: { color: d.color, width: 2 } },
          error_x: range ? { type: 'data', symmetric: false, array: [range[1] - r.obsMid], arrayminus: [r.obsMid - range[0]], color: d.color, thickness: 1 } : undefined,
          hovertemplate: `${d.name} ${r.product && r.product.name ? r.product.name + ' ' : ''}${r.v.dose} mg · ${AP.t('pt.v.ep.' + r.e.endpoint, { t: r.v.at })} (${r.analyteName})<br>${AP.t('pt.v.observed')} %{x:.3g} ${unit}<br>${AP.t('pt.v.predicted')} %{y:.3g} ${unit}<extra></extra>` });
      });
    };
    const cu = AP.concUnit(), crit = B.model.validation.criteria;
    panel('concentration', { x: 'x', y: 'y' }, cu, 0.1, 3000, crit.concentration);
    panel('time', { x: 'x2', y: 'y2' }, 'h', 0.1, 3000, crit.time);
    const ax = (title, domain, range, ticks) => ({ title: { text: title }, type: 'log', domain, range, tickvals: ticks, ticktext: ticks.map(x => AP.fmt(x, x < 1 ? 1 : 0)), gridcolor: '#f1f3f5', zeroline: false });
    const CT = [0.1, 1, 10, 100, 1000], TT = [0.1, 1, 10, 100, 1000];
    Plotly.newPlot(el, [...lines, ...traces], {
      height: 420, margin: { l: 60, r: 20, t: 36, b: 52 }, font: AP.plotFont(), hoverlabel: AP.plotHover(), separators: AP.plotSeparators(),
      paper_bgcolor: '#fff', plot_bgcolor: '#fff', hovermode: 'closest',
      xaxis: ax(AP.t('pt.v.obsConc', { unit: cu }), [0, 0.44], [-1, Math.log10(3000)], CT), yaxis: ax(AP.t('pt.v.predConc', { unit: cu }), [0, 1], [-1, Math.log10(3000)], CT),
      xaxis2: ax(AP.t('pt.v.obsTime'), [0.56, 1], [-1, Math.log10(3000)], TT), yaxis2: { ...ax(AP.t('pt.v.predTime'), [0, 1], [-1, Math.log10(3000)], TT), anchor: 'x2' },
      legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.2 },
      annotations: [{ text: AP.t('pt.v.concentrations'), x: 0.22, xref: 'paper', y: 1.08, yref: 'paper', showarrow: false, font: AP.plotFont() },
        { text: AP.t('pt.v.times'), x: 0.78, xref: 'paper', y: 1.08, yref: 'paper', showarrow: false, font: AP.plotFont() }],
    }, { displayModeBar: false, responsive: true });
  }

  /* ---------- Table definitions: id, title, JSON path, column headers, rows ([drugKey, cells]) ---------- */
  function tables(B, P) {
    const drugs = Object.entries(B.drugs);
    const T = B.regions.order;
    const valRows = validationRows(B);
    const kiCell = (x) => (x >= AP.NB ? AP.t('pt.notBound') : num(x));
    return [
      {
        id: 'binding', title: AP.t('pt.binding.title'), source: 'drugs.*.mw, smiles, pd.ki',
        head: [AP.t('pt.h.drug'), AP.t('pt.h.class'), ['MW', 'g/mol'], ...T.map(t => [`Kᵢ ${B.targets[t].label}`, 'nM']), 'SMILES'],
        abbr: AP.t('pt.binding.abbr'),
        rows: drugs.map(([k, d]) => [k, [d.name, d.role, num(d.mw), ...T.map(t => (window.Models.isNd(d, t) ? AP.t('pt.notDetermined') : kiCell(d.pd.ki[t]))), `<code>${esc(d.smiles || '-')}</code>`]]),
      },
      {
        id: 'potency', title: AP.t('pt.potency.title'), source: 'drugs.*.pd.ki, pd.ec50, pk.fu (derived)',
        head: [AP.t('pt.h.drug'), ...T.map(t => [`EC₅₀ ${B.targets[t].label}`, AP.concUnit()])],
        abbr: AP.t('pt.potency.abbr'),
        rows: drugs.filter(([, d]) => d.pk).map(([k, d]) => [k, [d.name, ...T.map(t => {
          const e = window.Models.plasmaEC50(d, t);
          return Number.isFinite(e) ? sig(AP.conc(e, d.mw)) : AP.t(window.Models.isNd(d, t) ? 'pt.notDetermined' : 'pt.notBound');
        })]]),
      },
      {
        id: 'pd', title: AP.t('pt.pd.title'), source: 'drugs.*.pd (ia, ec50)',
        head: [AP.t('pt.h.drug'), AP.t('pt.h.mechanism'), ['α D2', '0-1'], ['α D3', '0-1'], ['α 5-HT1A', '0-1'], [AP.t('pt.h.ec50'), AP.concUnit()], AP.t('pt.h.studies')],
        abbr: AP.t('pt.pd.abbr'),
        rows: drugs.map(([k, d]) => {
          const ia = d.pd.ia || {}, s = P.sources[`drugs.${k}.pd.ec50`];
          return [k, [d.name, d.pd.ki.d2 >= AP.NB ? d.pd.kind : AP.t(window.Models.ia(d, 'd2') > 0 ? 'pt.partialAgonist' : 'pt.antagonist'), num(ia.d2 ?? 0), num(ia.d3 ?? 0), num(ia.ht1a ?? 0),
            d.pd.ec50 ? sig(AP.conc(d.pd.ec50, d.mw)) : '-', s ? s.refs.map(id => refShort(P, id)).join('; ') : '-']];
        }),
      },
      {
        id: 'pk', title: AP.t('pt.pk.title'), source: 'drugs.*.pk',
        head: [AP.t('pt.h.drug'), ['F', '%'], ['kₐ', '1/h'], ['t½', 'h'], [AP.t('pt.h.vd'), 'L/kg'], [AP.t('pt.h.fu'), '%'], [AP.t('pt.h.dose'), 'mg'], ['τ', 'h'], [AP.t('pt.h.refRange'), AP.concUnit()], [AP.t('pt.h.pathways'), AP.t('pt.h.ofClearance')]],
        abbr: AP.t('pt.pk.abbr'),
        rows: drugs.filter(([, d]) => d.pk).map(([k, d]) => [k, [d.name, d.pk.apparent ? AP.t('pt.apparentF') : pctN(d.pk.F), num(d.pk.ka), num(d.pk.t12), num(d.pk.vd), num(+(d.pk.fu * 100).toPrecision(2)),
          num(d.pk.dose), num(d.pk.tau), d.pk.ref ? d.pk.ref.map(x => sig(AP.conc(x, d.mw))).join('-') : '-', pathsN(d.pk.pathways)]]),
      },
      {
        id: 'routes', title: AP.t('pt.routes.title'), source: 'drugs.*.pk.rt, drugRoutes',
        head: [AP.t('pt.h.drug'), AP.t('pt.h.route'), ['F', '%'], ['kₐ', '1/h'], [AP.t('pt.h.tabs'), AP.t('pt.h.days')], [AP.t('pt.h.lag'), 'h'], [AP.t('pt.h.dose'), 'mg'], ['τ', 'h'], AP.t('pt.h.onset'), AP.t('pt.h.tmax')],
        abbr: AP.t('pt.routes.abbr'),
        rows: drugs.filter(([, d]) => d.pk).flatMap(([k, d]) => (d.routes || ['oral']).flatMap(r => {
          const abs = r === 'oral' || r === 'odt' ? { F: d.pk.F, ka: d.pk.ka, ...((d.pk.rt || {})[r] || {}) } : (d.pk.rt || {})[r] || (r === 'iv' ? { F: 1, ka: 0 } : B.model.routeDefaults[r] || {});
          const clin = (B.drugRoutes[k] || {})[r] || {};
          // depots: one row per product; release phases shown by the phase carrying most of the dose
          const prods = window.Models.routeProducts(d, r).filter(a => a.name);
          const list = prods.length ? prods.map(a => ({ ...abs, ...a, dose: a.strengths ? window.Models.strengthsOf(a).map(x => x.mg).join(', ') : a.dose })) : [abs];
          return list.map(a => {
            const main = (a.release || []).reduce((x, y) => (!x || y.f > x.f ? y : x), null);
            const tAbs = main ? main.tAbs_d : a.tAbs_d, lag = main ? (main.lag_d ? main.lag_d * 24 : undefined) : a.tlag;
            return [k, [d.name, a.name ? `${ROUTE_NAMES[r] || r} · ${a.name}` : ROUTE_NAMES[r] || r, pctN(a.F), tAbs ? '-' : num(a.ka === undefined ? '-' : sig(a.ka)), num(tAbs ?? '-'), num(lag ?? '-'),
              num(a.dose ?? '-'), num(a.tau ?? '-'), num(clin.onset || '-'), num(clin.tmax || '-')]];
          });
        })),
      },
      {
        id: 'metabolites', title: AP.t('pt.metabolites.title'), source: 'drugs.*.pk.metabolites',
        head: [AP.t('pt.h.parentDrug'), AP.t('pt.h.metabolite'), AP.t('pt.h.from'), [AP.t('pt.h.fm'), '%'], ['t½', 'h'], [AP.t('pt.h.vd'), 'L/kg'], ['MW', 'g/mol'], AP.t('pt.h.d2Active'), [AP.t('pt.h.pathways'), AP.t('pt.h.ofClearance')]],
        abbr: AP.t('pt.metabolites.abbr'),
        rows: drugs.filter(([, d]) => d.pk && d.pk.metabolites).flatMap(([k, d]) => d.pk.metabolites.map(m => [k, [d.name, m.name,
          m.from === 'parent' ? d.name : (d.pk.metabolites.find(x => x.key === m.from) || {}).name || m.from, pctN(m.fm), num(m.t12), num(m.vd), num(m.mw), AP.t(m.d2 ? 'pt.yes' : 'pt.no'), pathsN(m.pathways)]])),
      },
      {
        id: 'targets', title: AP.t('pt.targets.title'), source: 'targets.*',
        head: [AP.t('pt.h.target'), AP.t('pt.h.family'), AP.t('pt.h.endogenous'), AP.t('pt.h.effect')],
        rows: T.map(t => [null, [B.targets[t].label, B.targets[t].family, B.targets[t].endogenous, B.targets[t].effect]]),
      },
      {
        id: 'pathways', title: AP.t('pt.pathways.title'), source: 'dopaminePathways.*',
        head: [AP.t('pt.h.pathway'), AP.t('pt.h.projection'), ['DA', 'nM'], AP.t('pt.h.origin'), AP.t('pt.h.targets'), AP.t('pt.h.branches'), [AP.t('pt.h.course'), 'MNI152, mm']],
        abbr: AP.t('pt.pathways.abbr'),
        rows: Object.values(B.pathways).map(p => [null, [p.label, p.route, num(p.da), p.geometry.origin, p.geometry.targets, String(p.geometry.mni.length),
          p.geometry.mni.map(line => line.map(pt => `(${pt.map(num).join(', ')})`).join(' → ')).join('<br>')]]),
      },
      {
        id: 'routetypes', title: AP.t('pt.routetypes.title'), source: 'routes.*',
        head: [AP.t('pt.h.route'), AP.t('pt.h.onset'), [AP.t('pt.h.typicalOnset'), 'min'], AP.t('pt.h.tmax'), 'F'],
        abbr: AP.t('pt.routetypes.abbr'),
        rows: B.routes.map(r => [null, [r.name, num(r.onset), num(r.onsetMin), num(r.tmax), num(r.bioavailability)]]),
      },
      {
        id: 'modifiers', title: AP.t('pt.modifiers.title'), source: 'modifiers.*',
        head: [AP.t('pt.h.factor'), AP.t('pt.h.clMultipliers'), AP.t('pt.h.description')],
        abbr: AP.t('pt.modifiers.abbr'),
        rows: Object.values(B.modifiers).map(m => [null, [m.label, Object.entries(m.m).map(([k, v]) => `${PATHWAYS[k] || k} ×${num(v)}`).join(', '), m.desc]]),
      },
      {
        id: 'regions', title: AP.t('pt.regions.title'), source: 'regions',
        head: [AP.t('pt.h.brainRegion'), AP.t('pt.h.target'), AP.t('pt.h.abundance'), [AP.t('pt.h.level'), '0-3'], AP.t('pt.h.cellPopulations')],
        rows: Object.entries(B.regions.abundance).flatMap(([t, regs]) => Object.entries(regs).map(([r, v]) =>
          [null, [B.regions.names[r], B.targets[t].label, v.level == null ? AP.t('dist.levelUnknown') : B.regions.levels[v.level], v.level == null ? '-' : String(v.level), v.note || '-']])),
      },
      {
        id: 'model', title: AP.t('pt.model.title'), source: 'model',
        head: [AP.t('pt.h.parameter'), AP.t('pt.h.value'), AP.t('pt.h.unit'), AP.t('pt.h.description')],
        rows: (() => {
          const M = B.model, rows = [];
          const add = (name, value, unit, desc) => rows.push([null, [name, typeof value === 'number' ? AP.fmt(value, value % 1 ? Math.min(3, String(value).split('.')[1].length) : 0) : String(value), unit || '-', desc]]);
          add(AP.t('pt.m.kDa'), M.dopamine.K_nM, 'nM', AP.t('pt.m.kDaD'));
          add(AP.t('pt.m.tonic'), M.dopamine.tonic_nM, 'nM', AP.t('pt.m.tonicD'));
          add(AP.t('pt.m.response'), M.thresholds.response * 100, '%', AP.t('pt.m.thresholdD'));
          add(AP.t('pt.m.prolactin'), M.thresholds.prolactin * 100, '%', AP.t('pt.m.thresholdD'));
          add(AP.t('pt.m.eps'), M.thresholds.eps * 100, '%', AP.t('pt.m.thresholdD'));
          Object.entries(M.routeDefaults).forEach(([r, v]) => {
            add(AP.t('pt.m.defF', { route: ROUTE_NAMES[r] || r }), v.F * 100, '%', AP.t('pt.m.defD'));
            add(AP.t('pt.m.defKa', { route: ROUTE_NAMES[r] || r }), v.ka, '1/h', AP.t('pt.m.defD'));
          });
          M.durationComparison.forEach(c => add(AP.t('pt.m.duration', { drug: B.drugs[c.drug].name }), c.dose, AP.t('pt.m.mgOral'), AP.t('pt.m.durationD')));
          return rows;
        })(),
      },
      {
        id: 'clinical', title: AP.t('pt.clinical.title'), source: 'substances',
        head: [AP.t('pt.h.substance'), AP.t('pt.h.category'), 't½', [AP.t('pt.h.tUsed'), 'h'], AP.t('pt.h.metabolites'), 'F', AP.t('pt.h.clearance'), AP.t('pt.h.equivalentDose'), AP.t('pt.h.indications')],
        abbr: AP.t('pt.clinical.abbr'),
        note: AP.t('pt.clinical.note'),
        rows: P.substances.map(s => [s.key, [s.name, s.category, num(s.tHalf), num(s.tHalfNum), s.metabolites, num(s.bioavailability), s.clearance, num(s.olz), s.indications]]),
      },
      {
        id: 'sources', title: AP.t('pt.sources.title'), source: 'sources',
        intro: (() => {
          const c = {}; Object.values(P.sources).forEach(s => { c[s.status] = (c[s.status] || 0) + 1; });
          return AP.t('pt.sources.intro', { n: Object.keys(P.sources).length, list: Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${STATUS[k][0].toLowerCase()} ${v}`).join(', ') });
        })(),
        head: [[AP.t('pt.h.value'), AP.t('pt.h.path')], AP.t('pt.h.valueUsed'), AP.t('pt.h.reported'), AP.t('pt.h.status'), AP.t('pt.h.references'), AP.t('pt.h.note')],
        abbr: AP.t('pt.sources.abbr'),
        rows: Object.entries(P.sources).map(([path, s]) => {
          const [label, tip] = STATUS[s.status] || [s.status, ''];
          const drug = path.startsWith('drugs.') ? path.split('.')[1] : null;
          return [drug, [`<code class="props-path">${esc(path).replace(/\./g, '.<wbr>')}</code>`, esc(show(getPath(AP.raw, path))), esc(s.reported),
            `<span class="props-status props-status-${s.status.replace(/ /g, '-')}" title="${tip}">${label}</span>`,
            s.refs.map(id => refShort(P, id)).join('; ') || '-', esc(s.note || '-')]];
        }),
      },
      {
        id: 'validation', title: AP.t('pt.validation.title'), source: 'validation (observed); model.validation (criteria); js/models.js (predicted)',
        intro: (() => {
          const count = (set) => { const r = valRows.filter(x => x.v.set === set && x.e.pass !== null); return [r.filter(x => x.e.pass).length, r.length]; };
          const [c, cn] = count('calibration'), [v, vn] = count('validation');
          return AP.t('pt.v.intro', { c, cn, v, vn });
        })(),
        after: '<div id="val-plot" class="val-plot"></div>',
        draw: () => drawValidation(B, valRows),
        head: [AP.t('pt.h.set'), AP.t('pt.h.drug'), AP.t('pt.h.route'), AP.t('pt.h.regimen'), AP.t('pt.h.analyte'), AP.t('pt.h.endpoint'), AP.t('pt.h.observed'), AP.t('pt.h.predicted'), [AP.t('pt.h.ratio'), AP.t('pt.h.predObs')], AP.t('pt.h.references'), AP.t('pt.h.note')],
        abbr: AP.t('pt.validation.abbr'),
        rows: valRows.map(r => [r.v.drug, [AP.t(r.v.set === 'validation' ? 'pt.v.validation' : 'pt.v.calibration'), B.drugs[r.v.drug].name,
          `${ROUTE_NAMES[r.v.route] || r.v.route}${r.product && r.product.name ? ` · ${esc(r.product.name)}` : ''}${r.v.region ? ` (${r.v.region.toUpperCase()})` : ''}`,
          `${num(r.v.dose)} mg${r.v.steadyState ? `, ${AP.t('pt.v.steadyState', { tau: num(r.v.tau) })}` : `, ${AP.t('pt.v.singleDose')}`}`,
          esc(r.analyteName), AP.t('pt.v.ep.' + r.e.endpoint, { t: num(r.v.at) }), `${obsText(r.obs)} ${unitOf(r.e.kind)}`, r.pred === null ? '-' : `${sig(r.pred)} ${unitOf(r.e.kind)}`, statusCell(r),
          r.v.refs.map(id => refShort(P, id)).join('; '), esc(r.v.note || '-')]]),
      },
      {
        id: 'references', title: AP.t('pt.references.title'), source: 'references',
        head: [AP.t('pt.h.reference'), AP.t('pt.h.links')],
        rows: Object.entries(P.references).sort(([, a], [, b]) => a.authors.localeCompare(b.authors) || a.year - b.year)
          .map(([id, r]) => [null, [`<span id="ref-${id}">${cite(r)}</span>`, refLinks(r)]]),
      },
    ];
  }

  let model = [];
  const state = { q: '', drug: '', shown: new Set() };

  function render() {
    const q = state.q.trim().toLowerCase();
    let visible = 0;
    const html = model.filter(t => state.shown.has(t.id)).map(t => {
      const rows = t.rows.filter(([key, cells]) => (!state.drug || key === state.drug)
        && (!q || cells.join(' ').replace(/<[^>]+>/g, '').toLowerCase().includes(q)));
      visible += rows.length;
      if (!rows.length) return '';
      return `
        <section class="card props-card" id="t-${t.id}">
          <h3>${t.title} <span class="props-count">${rows.length}</span></h3>
          <p class="muted props-source">${AP.t('pt.source')} <code>${esc(t.source)}</code></p>${t.intro ? `<p class="props-intro">${t.intro}</p>` : ''}${t.after || ''}
          <div class="table-responsive">
            <table class="props-table">
              <thead><tr>${t.head.map(h => `<th>${headCell(h)}</th>`).join('')}</tr></thead>
              <tbody>${rows.map(([, cells]) => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
            </table>
          </div>${t.abbr || t.note ? `<p class="props-abbr">${t.abbr ? `<b>${AP.t('subst.abbr')}</b> ${t.abbr}.` : ''}${t.note ? ` ${t.note}.` : ''}</p>` : ''}
        </section>`;
    }).join('');
    document.getElementById('props-content').innerHTML = html;
    model.forEach(t => { if (t.draw && document.getElementById(`t-${t.id}`)) t.draw(); });
    document.getElementById('props-empty').hidden = visible > 0;
  }

  function init(P) {
    const B = window.AP;
    model = tables(B, P);
    model.forEach(t => state.shown.add(t.id));

    const pills = document.getElementById('props-tables');
    pills.innerHTML = `<button type="button" class="pill active" data-t="all">${AP.t('pt.all')}</button>` +
      model.map(t => `<button type="button" class="pill" data-t="${t.id}">${t.title.split(' (')[0]}</button>`).join('');
    pills.addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      const id = b.getAttribute('data-t');
      state.shown = new Set(id === 'all' ? model.map(t => t.id) : [id]);
      pills.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      render();
    });

    const sel = document.getElementById('props-drug');
    Object.entries(B.drugs).forEach(([k, d]) => sel.insertAdjacentHTML('beforeend', `<option value="${k}">${esc(d.name)}</option>`));
    sel.addEventListener('change', () => { state.drug = sel.value; render(); });

    const search = document.getElementById('props-search');
    search.addEventListener('input', () => { state.q = search.value; render(); });

    // Links from a value to its reference: jump at once, show the references table if it is
    // filtered out, and highlight the row briefly
    document.getElementById('props-content').addEventListener('click', ev => {
      const a = ev.target.closest('a[href^="#ref-"]'); if (!a) return;
      ev.preventDefault();
      const id = a.getAttribute('href').slice(1);
      if (!document.getElementById(id)) {
        state.shown.add('references'); state.q = ''; state.drug = '';
        search.value = ''; sel.value = '';
        pills.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.getAttribute('data-t') === 'all' && state.shown.size === model.length));
        render();
      }
      const t = document.getElementById(id); if (!t) return;
      const row = t.closest('tr') || t;
      row.scrollIntoView({ behavior: 'instant', block: 'center' });
      history.replaceState(null, '', `#${id}`);
      row.classList.remove('ref-flash'); void row.offsetWidth; row.classList.add('ref-flash');
    });

    render();
  }

  document.addEventListener('DOMContentLoaded', () => {
    AP.load().then((P) => { AP.translatePage(); AP.initSettings(); init(P); }).catch(err => {
      document.getElementById('props-content').innerHTML = `<div class="card data-error"><b>${AP.t('pt.loadError')}</b> ${esc(err.message)}</div>`;
    });
  });
})();
