// Loads the app's data and model code (js/data.js, js/models.js) into Node with a minimal browser stub,
// so tests and tools run exactly the code the browser runs. Usage: const app = await loadApp(); app.use('se');
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

export async function loadApp() {
  const store = {};
  const ctx = {
    console, URL, URLSearchParams, setTimeout,
    location: { search: '', href: 'http://localhost/', protocol: 'http:' },
    navigator: { languages: ['en-US'], language: 'en-US' },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
    document: { documentElement: { lang: '' }, addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/data.js'), ctx, { filename: 'js/data.js' });
  vm.runInContext(read('js/models.js'), ctx, { filename: 'js/models.js' });
  const { AP, Models } = ctx;
  const raw = JSON.parse(read('assets/data/properties.json'));
  const i18n = { en: JSON.parse(read('assets/i18n/en.json')), sv: JSON.parse(read('assets/i18n/sv.json')) };
  AP.raw = raw;
  /** Switch the model to a region's data (us, eu, se), as AP.load() does in the browser */
  const use = (region) => {
    const p = AP.regionData(raw, region);
    AP.region = region;
    AP.jurisdiction = (p.jurisdictions || {})[region] || null;
    Object.assign(AP, { drugs: p.drugs, model: p.model, modifiers: p.modifiers, validation: p.validation,
      DA: { K: p.model.dopamine.K_nM, TONIC: p.model.dopamine.tonic_nM } });
    return p;
  };
  use('us');
  return { AP, Models, raw, i18n, use, ROOT };
}
