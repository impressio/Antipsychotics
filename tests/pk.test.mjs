// Pharmacokinetic model tests: mathematical correctness (exact solutions, numerical convergence, mass balance,
// superposition, units), model features (metabolite chains, initiation regimens, strengths, regions), a regression
// snapshot of every product, the validation table and the interface safeguards.
// Run: node --test tests/   ·   update the snapshot after an intended model change: UPDATE_BASELINE=1 node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadApp } from './load-app.mjs';

const app = await loadApp();
const { AP, Models } = app;
const LN2 = Math.LN2;
const rel = (a, b) => Math.abs(a / b - 1);
const sample = (sim, t) => { const i = sim.t.findIndex(x => x >= t - 1e-9); return sim.cp[i]; };

/** A drug without metabolites for the exact solutions */
const testDrug = (pk) => ({ name: 'Test', mw: 400, pd: { ki: {}, nd: [] }, pk: { F: 1, ka: 1, t12: 6, vd: 1, fu: 0.1, pathways: { other: 1 }, metabolites: [], dose: 10, tau: 12, ...pk } });
const base = { weight: 70, mods: [] };

/** Every region, drug, route and product with its default regimen */
function regimens() {
  const out = [];
  for (const region of ['us', 'eu', 'se']) {
    app.use(region);
    for (const [key, drug] of Object.entries(AP.drugs)) {
      if (!drug.pk) continue;
      for (const route of drug.routes || ['oral']) {
        for (const p of Models.routeProducts(drug, route)) {
          Models.selectProduct(drug, route, p.key);
          const reg = Models.regimenFor(drug, route);
          out.push({ region, key, drug, route, product: p.key, dose: reg.dose, tau: reg.tau });
        }
        Models.selectProduct(drug, route, undefined);
      }
    }
  }
  return out;
}
const REGIMENS = regimens();

test('exact solution: intravenous bolus', () => {
  const d = testDrug({}), sim = Models.simulate({ drug: d, dose: 10, route: 'iv', n: 1, tau: 12, ...base, tEnd: 48, dt: 0.01, points: 1e6 });
  const V = 70, k = LN2 / 6;
  for (const t of [1, 6, 12, 24, 47]) assert.ok(rel(sample(sim, t), 10 / V * Math.exp(-k * t) * 1000) < 1e-4, `t = ${t} h`);
});

test('exact solution: first-order absorption (Bateman)', () => {
  const d = testDrug({ F: 0.6, ka: 1.2 }), sim = Models.simulate({ drug: d, dose: 10, route: 'oral', n: 1, tau: 12, ...base, tEnd: 48, dt: 0.01, points: 1e6 });
  const V = 70, k = LN2 / 6, ka = 1.2;
  const C = (t) => 0.6 * 10 * ka / (V * (ka - k)) * (Math.exp(-k * t) - Math.exp(-ka * t)) * 1000;
  for (const t of [0.5, 1, 2, 6, 24]) assert.ok(rel(sample(sim, t), C(t)) < 1e-4, `t = ${t} h`);
  assert.ok(Math.abs(sim.params.tmax - Math.log(ka / k) / (ka - k)) < 0.06, 'Tmax');
});

test('superposition: repeated doses equal the sum of shifted single doses', () => {
  const d = testDrug({ ka: 0.8 });
  const sim3 = Models.simulate({ drug: d, dose: 10, route: 'oral', n: 3, tau: 12, ...base, tEnd: 72, dt: 0.01 });
  const sim1 = Models.simulate({ drug: d, dose: 10, route: 'oral', n: 1, tau: 12, ...base, tEnd: 72, dt: 0.01 });
  for (const t of [6, 18, 30, 40, 60]) {
    const sum = [0, 12, 24].reduce((a, s) => a + (t >= s ? sample(sim1, t - s) : 0), 0);
    assert.ok(rel(sample(sim3, t), sum) < 2e-3, `t = ${t} h`);
  }
});

test('numerical convergence: a 4 times smaller step changes peak and time to peak by < 0.5 %', () => {
  app.use('us');
  for (const r of REGIMENS.filter(x => x.region === 'us')) {
    const opts = { drug: r.drug, dose: r.dose, route: r.route, n: 1, tau: r.tau, productKey: r.product, ...base };
    const a = Models.simulate(opts);
    const dt = Math.min(0.05, a.tEnd / 4000) / 4;
    const b = Models.simulate({ ...opts, tEnd: a.tEnd, dt, points: 1500 });
    assert.ok(rel(a.params.cmax, b.params.cmax) < 5e-3, `${r.key}/${r.route}/${r.product} Cmax`);
  }
});

test('mass balance: every regimen converges to the exact steady-state average (F·D/(CL·τ), metabolites along their chain)', () => {
  for (const region of ['us', 'eu']) {
    app.use(region);
    for (const r of REGIMENS.filter(x => x.region === region)) {
      const ss = Models.steadyState({ drug: AP.drugs[r.key], dose: r.dose, route: r.route, tau: r.tau, productKey: r.product, ...base });
      assert.ok(ss.converged, `${region} ${r.key}/${r.route}/${r.product}: ${ss.species.moiety.cavg} vs ${ss.asymptote.moiety}`);
      for (const [k, sp] of Object.entries(ss.species)) if (sp.asymptote > 0) assert.ok(rel(sp.cavg, sp.asymptote) < 0.01, `${region} ${r.key}/${r.route}/${r.product} ${k}`);
    }
  }
});

test('metabolite chain: didesmethylcariprazine forms through desmethylcariprazine', () => {
  app.use('us');
  const d = AP.drugs.cariprazine, e = Models.effectivePK(d, [], 70);
  const ss = Models.steadyState({ drug: d, dose: 3, route: 'oral', tau: 24, ...base });
  const [dcar, ddcar] = d.pk.metabolites, m = e.metabolites[1];
  const exact = dcar.fm * ddcar.fm * e.F * 3 / (m.CL * 24) * 1000;
  assert.ok(rel(ss.asymptote.ddcar, exact) < 1e-9 && rel(ss.species.ddcar.cavg, exact) < 0.01);
});

test('units: ng/mL (US), µg/L (EU) and nmol/L (SE) with the molar mass of each species', () => {
  app.use('us'); assert.equal(AP.concUnit(), 'ng/mL'); assert.equal(AP.conc(10, 410.5), 10);
  app.use('eu'); assert.equal(AP.concUnit(), 'µg/L'); assert.equal(AP.conc(10, 410.5), 10);
  app.use('se'); assert.equal(AP.concUnit(), 'nmol/L'); assert.ok(rel(AP.conc(410.5, 410.5), 1000) < 1e-12);
  const met = AP.drugs.risperidone.pk.metabolites[0];
  assert.ok(rel(AP.conc(42.65, met.mw), 100) < 1e-3, '9-hydroxyrisperidone uses its own molar mass');
  app.use('us');
});

test('regions: regional half-lives change the curve shape but not the exposure', () => {
  const avg = (region, key) => { app.use(region); const d = AP.drugs[key], b = app.raw.drugs[key].pk; return Models.steadyState({ drug: d, dose: b.dose, route: 'oral', tau: b.tau, ...base }).asymptote.moiety; };   // same regimen in every region
  for (const key of Object.keys(app.raw.drugs)) if (app.raw.drugs[key].pk) {
    const us = avg('us', key);
    assert.ok(rel(avg('eu', key), us) < 1e-9 && rel(avg('se', key), us) < 1e-9, key);
  }
  app.use('us');
});

test('initiation: Invega Sustenna loading doses on day 1 and 8, maintenance from day 36', () => {
  app.use('us');
  const d = AP.drugs.paliperidone, prod = Models.routeProduct(d, 'lai', 'sustenna');
  const init = Models.initiationsFor(prod, 75, 672).loading;
  const opts = { drug: d, dose: 75, route: 'lai', n: 2, tau: 672, productKey: 'sustenna', ...base };
  const withLoad = Models.simulate({ ...opts, initiation: init }), without = Models.simulate(opts);
  assert.equal(JSON.stringify(withLoad.extras.flatMap(x => x.times)), '[0,168]');
  assert.equal(withLoad.doseTimes[0], 35 * 24);
  assert.ok(sample(withLoad, 14 * 24) > 2 * sample(without, 14 * 24), 'loading raises the first-month level');
});

test('strengths: Abilify Maintena 960 mg (EU) uses the 2-monthly formulation, 400 mg the monthly one', () => {
  app.use('eu');
  const d = AP.drugs.aripiprazole, e = Models.effectivePK(d, [], 70);
  assert.equal(Models.routeAbsorption(d, 'lai', e, { key: 'maintena', dose: 960, tau: 1344 }).F, 1.18);
  assert.equal(Models.routeAbsorption(d, 'lai', e, { key: 'maintena', dose: 400, tau: 672 }).F, 1.44);
  app.use('us');
});

test('regression: single-dose and steady-state results of every product in every region match the snapshot', () => {
  const file = new URL('./pk-baseline.json', import.meta.url);
  const now = {};
  for (const r of REGIMENS) {
    app.use(r.region);
    const drug = AP.drugs[r.key], opts = { drug, dose: r.dose, route: r.route, tau: r.tau, productKey: r.product, ...base };
    const one = Models.simulate({ ...opts, n: 1 }), ss = Models.steadyState(opts);
    const k = `${r.region}/${r.key}/${r.route}/${r.product || '-'}`;
    now[k] = { dose: r.dose, tau: r.tau, cmax: +one.params.cmax.toPrecision(5), tmax: +one.params.tmax.toPrecision(5),
      cavg: +ss.species.moiety.cavg.toPrecision(5), cmin: +ss.species.moiety.cmin.toPrecision(5), cmaxSS: +ss.species.moiety.cmax.toPrecision(5), t95: ss.t95 && ss.t95.dose };
  }
  if (process.env.UPDATE_BASELINE || !existsSync(file)) { writeFileSync(file, JSON.stringify(now, null, 1) + '\n'); return; }
  const before = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(JSON.stringify(Object.keys(now).sort()), JSON.stringify(Object.keys(before).sort()), 'the set of products changed');
  for (const [k, v] of Object.entries(now)) for (const [f, x] of Object.entries(v)) {
    const y = before[k][f];
    assert.ok(x === y || (typeof x === 'number' && typeof y === 'number' && rel(x, y) < 1e-3), `${k} ${f}: ${y} → ${x}`);
  }
});

test('validation: every calibration endpoint is met; independent endpoints match the recorded status', () => {
  const status = {};
  for (const v of app.raw.validation) {
    app.use(v.region || 'us');
    for (const e of Models.validateCase(v, AP.drugs[v.drug])) {
      const k = `${v.set}: ${v.drug}/${v.route}/${v.product || '-'}/${v.analyte || 'parent'}/${v.steadyState ? 'ss' : 'single'} ${e.endpoint}`;
      status[k] = e.pass;
      if (v.set === 'calibration') assert.ok(e.pass, `${k}: predicted ${e.pred}, observed ${JSON.stringify(e.obs)}`);
    }
  }
  const vfile = new URL('./pk-validation-status.json', import.meta.url);
  if (process.env.UPDATE_BASELINE || !existsSync(vfile)) { writeFileSync(vfile, JSON.stringify(status, null, 1) + '\n'); return; }
  assert.equal(JSON.stringify(status, null, 1), JSON.stringify(JSON.parse(readFileSync(vfile, 'utf8')), null, 1), 'validation status changed (update the snapshot if intended)');
});

test('interface safeguards: model note in both languages, no treatment-directive wording', () => {
  const html = readFileSync(app.ROOT + 'index.html', 'utf8');
  assert.ok(html.includes('data-i18n="pk.modelNote"'), 'model note under the PK plot');
  for (const l of ['en', 'sv']) {
    const ui = app.i18n[l].ui;
    for (const k of ['pk.modelNote', 'footer.disclaimer', 'pt.v.intro']) assert.ok(ui[k] && ui[k].length > 40, `${l}: ${k}`);
  }
  const en = Object.values(app.i18n.en.ui).join(' ').toLowerCase();
  for (const phrase of ['increase the dose', 'reduce the dose', 'optimal dose', 'recommended dose for you']) assert.ok(!en.includes(phrase), phrase);
});
