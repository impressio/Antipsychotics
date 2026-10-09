# AP·D<sub>2</sub>: antipsychotic pharmacology

An interactive teaching resource on antipsychotics and the dopamine D<sub>2</sub> receptor: receptor structure, competitive antagonism and partial agonism, receptor targets and their regional distribution, dopaminergic pathways, substances, administration routes, pharmacodynamics and pharmacokinetics. Live at [ap.matty.se](https://ap.matty.se); all data are listed with their sources on the [data page](https://ap.matty.se/properties.html).

## 1. Running locally

The app is static HTML, CSS and JavaScript with CDN libraries (Plotly.js, 3Dmol.js, three.js, KaTeX); there is no build step. It loads its model files with `fetch()`, which browsers block for pages opened from disk, so serve the folder:

```bash
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000). The model files in `assets/models/` and the structure drawings are prebuilt and committed; the scripts in `tools/` are needed only when their source data change.

## 2. Data, sources and validation

- **Data:** all domain data are in `assets/data/properties.json`, with the units and meaning of each field in its `meta` section. `js/data.js` loads the file; the app and the data page both read it. Edit a value and reload.
- **Sources:** `references` lists the literature (each checked against PubMed, DailyMed, FASS or EMA), and `sources` records for each value its references, the value reported in the source and a status (consistent, calibrated, model, unverified, partly unverified, differs). Clinical pharmacokinetic values come from FDA labels where available, receptor affinities from section 12.2 of the label or else the ChEMBL median, compared with the IUPHAR/BPS Guide to Pharmacology. `python3 tools/check_sources.py` re-checks the references, reports newer FDA label revisions and compares the Kᵢ values with Guide to Pharmacology and ChEMBL; it only reports.
- **Validation:** `validation` holds observed peak concentrations and times to peak from the labels, split into a calibration set (used to fit the absorption rate constants) and an independent validation set. The data page simulates each study and plots predicted against observed values.

## 3. Language, values and units

The settings button in the top bar (e.g. "EN · US") selects the language and the regional values and units; both are remembered and can be set in the address (`?lang=sv&region=eu`). On the first visit, a Swedish browser or a Swedish region (e.g. `sv`, `en-SE`) gets Swedish with SE values, other European countries get English with EU values, and everything else gets US English with US values. Changing the language selects its default values and units, which can then be changed separately.

- **Language:** English or Swedish. Interface texts are in `assets/i18n/en.json` and `sv.json`; the `data` section of `sv.json` translates the descriptive texts of `properties.json` by path. Swedish follows FASS terminology and uses decimal commas.
- **Values and units:** US (FDA prescribing information, US brand names, ng/mL), EU (values that differ in the EU summaries of product characteristics as published in FASS, or from EMA where FASS has none; EU-wide product names, otherwise marked as nationally authorized; µg/L) or SE (EU values with Swedish product names and availability, and plasma concentrations in nmol/L converted per species by molecular weight). The EU values are an overlay in `jurisdictions.eu.data`; SE adds its Swedish names in `jurisdictions.se.data`. Each regional value has a source. Validation always uses the US values.

## 4. Project structure

```
Antipsychotics/
├── assets/
│   ├── data/
│   │   └── properties.json       # all domain data
│   ├── i18n/
│   │   ├── en.json               # English texts
│   │   └── sv.json               # Swedish texts
│   ├── icons/
│   │   ├── apple-touch-icon.png  # home-screen icon
│   │   └── favicon.ico           # browser icon
│   ├── images/
│   │   └── structures/           # 2D structure SVGs
│   └── models/                   # runtime model files
│       ├── 6CM4.pdb.gz           # receptor structure
│       ├── brain-2d.json         # 2D map layout
│       ├── brain-2d-*.png        # 2D map views
│       ├── brain-mesh.bin.gz     # 3D brain meshes
│       ├── brain-mesh.json       # 3D mesh index
│       ├── d2-poses.json         # ligand poses, active state
│       └── NOTICE                # sources, licenses
├── css/
│   ├── properties.css            # data tables page
│   ├── styles.css                # base layout
│   └── theme-figma.css           # Figma UI3 theme
├── js/
│   ├── brain3d.js                # 3D brain (three.js)
│   ├── data.js                   # data loader
│   ├── distribution.js           # regional distribution
│   ├── main.js                   # start-up, navigation
│   ├── model-files.js            # model file loader
│   ├── models.js                 # PD and PK models
│   ├── pd.js                     # PD plots
│   ├── pk.js                     # PK plots
│   ├── properties.js             # data tables page
│   ├── receptor.js               # mechanism controls
│   ├── routes.js                 # administration routes
│   ├── structure.js              # 3D receptor (3Dmol.js)
│   ├── substrates.js             # substances, metabolism
│   └── tex.js                    # KaTeX equations
├── tools/
│   ├── build_brain.py            # builds brain models
│   ├── build_receptor.py         # builds receptor model
│   ├── build_structures.py       # builds structure SVGs
│   ├── check_sources.py          # checks data sources
│   └── requirements.txt          # pinned build packages
├── CLAUDE.md                     # Claude Code rules
├── CNAME                         # GitHub Pages domain
├── index.html                    # main app
├── LICENSE                       # all rights reserved
├── properties.html               # data tables
├── pyrightconfig.json            # Python type checking
├── README.md                     # this file
└── TYPOGRAPHY.md                 # typography rules
```

| Path | Description |
| --- | --- |
| `assets/data/properties.json` | Single source of all domain data: drugs, receptors, dopaminergic pathways, routes, regions, model parameters, references, sources, validation and regional (EU/SE) values (units in its `meta` section) |
| `assets/i18n/` | Interface texts in English (`en.json`) and Swedish (`sv.json`, which also translates the descriptive texts of `properties.json` by path) |
| `assets/icons/` | Browser icon (`favicon.ico`, 16 px, 7-helix bundle logo) and home-screen icon (`apple-touch-icon.png`, 180 px) |
| `assets/images/structures/` | 2D chemical structure drawings (`<drug>.svg`) and NOTICE, built by `tools/build_structures.py` |
| `assets/models/` | Model data fetched at runtime: D<sub>2</sub> receptor structure (PDB 6CM4), haloperidol and dopamine poses with the active-state coordinates, 2D map layout and lateral views, 3D brain meshes (compact binary) with their index; sources and licenses in NOTICE |
| `css/properties.css` | Styles of the data tables page |
| `css/styles.css` | Typography tokens, base layout and components: responsive grid, cards, tables, plots, menu |
| `css/theme-figma.css` | Interface design (Figma UI3 style), layered on `styles.css` |
| `js/brain3d.js` | three.js 3D brain for the regional distribution map (translucent hemisphere, dopaminergic pathways) |
| `js/data.js` | Loader: `AP.load()` reads `properties.json` and exposes it as `window.AP`; interface texts, language and region settings, units |
| `js/distribution.js` | Regional distribution viewer: stage, 3D/2D switch, 2D canvas map, region list, pathway selection |
| `js/main.js` | Start-up after data loading, selection sync, navigation and compact menu |
| `js/model-files.js` | Loads files from `assets/models/` (fetch and built-in gzip decompression) |
| `js/models.js` | Pharmacodynamic (D<sub>2</sub> competition with dopamine, occupancy, plasma EC<sub>50</sub>) and pharmacokinetic (ODE simulation) models |
| `js/pd.js` | Plotly.js occupancy, dopamine competition, affinity and potency radar, and dose-occupancy plots; target cards |
| `js/pk.js` | Plotly.js plasma concentration-time profiles and derived parameter table |
| `js/properties.js` | Tables, search, filters and validation plot of `properties.html` |
| `js/receptor.js` | Mechanism controls, synapse model state, header and badge, info panel and readouts |
| `js/routes.js` | Administration routes comparison, route detail card and table |
| `js/structure.js` | Rotatable D<sub>2</sub> receptor (3Dmol.js): density map, ligands, inactive⇄active morph |
| `js/substrates.js` | Structure gallery, biotransformation pathways and interactive substances table |
| `js/tex.js` | LaTeX equations rendered with KaTeX (plain-text fallback if unavailable) |
| `tools/build_brain.py` | Builds the brain model files from TemplateFlow (fsaverage pial/sulc, MNI152 2009c aseg) |
| `tools/build_receptor.py` | Builds the receptor model files from RCSB entries 6CM4, 6LUQ and 8U02 |
| `tools/build_structures.py` | Builds the structure SVGs from the SMILES in `properties.json` (RDKit) |
| `tools/check_sources.py` | Checks the references (PubMed), FDA label revisions (openFDA) and Kᵢ values (Guide to Pharmacology, ChEMBL) against `properties.json`; report only |
| `tools/requirements.txt` | Pinned Python packages for the build scripts (numpy, scipy, RDKit) |
| `CLAUDE.md` | Instructions read by Claude Code (imports `TYPOGRAPHY.md`) |
| `CNAME` | Custom domain for GitHub Pages (ap.matty.se) |
| `index.html` | Main single-page application |
| `LICENSE` | Copyright notice: all rights reserved; third-party components keep their own licenses |
| `properties.html` | Searchable, filterable tables of all data in `properties.json` |
| `pyrightconfig.json` | Editor type checking: Python environment for `tools/` |
| `TYPOGRAPHY.md` | Typography rules: one font, size scale, tables equal body text, plots and canvas |

The build scripts share one environment: `python3 -m venv tools/.venv && tools/.venv/bin/python -m pip install -r tools/requirements.txt`. Rebuild the structure drawings after editing a SMILES (`tools/.venv/bin/python tools/build_structures.py`), the receptor model with `tools/build_receptor.py` (PDB entries are cached in `tools/.pdb-cache/`) and the brain models with `tools/build_brain.py` (TemplateFlow files are downloaded into `tools/.templateflow-cache/` on first run).

## 5. Sections

1. **Competitive antagonism at the receptor.** Crystal structure of the human D<sub>2</sub> receptor with risperidone (PDB 6CM4) as a rotatable simulated density map in a lipid bilayer; haloperidol (PDB 6LUQ) and dopamine (PDB 8U02) are shown in their own poses, other drugs on the risperidone pose. Controls for drug, dose (converted to a free concentration) and dopaminergic pathway, each pathway with its own synaptic dopamine concentration; readouts of D<sub>2</sub> occupancy by drug and by dopamine, functional blockade and G<sub>i/o</sub> signaling. When signaling rises, the structure morphs toward the active state (outward swing of TM6).
2. **Receptor targets and clinical effects.** Cards for D<sub>2</sub>, D<sub>3</sub>, 5-HT<sub>1A</sub>, 5-HT<sub>2A</sub>, 5-HT<sub>2C</sub>, H<sub>1</sub>, M<sub>1</sub> and α<sub>1</sub> (Kᵢ, intrinsic activity, plasma EC<sub>50</sub>, live occupancy, consequence of blockade or agonism) and for 5-HT<sub>7</sub>, M<sub>1</sub>/M<sub>4</sub> agonism, NET and hERG. Regional distribution on a 3D brain model (FreeSurfer fsaverage and MNI152 2009c structures) or a 2D map, with the abundance and the effects of activation and blockade in each region, and the four dopaminergic pathways drawn from their origin nuclei to their targets.
3. **Antipsychotic substances.** 2D structures of 20 drugs, from haloperidol and the thioxanthenes flupentixol and zuclopenthixol to milsaperidone and xanomeline-trospium, and a searchable comparison table with half-life, active metabolites, bioavailability, clearance, olanzapine-equivalent dose and indications, filterable by class (FGA, SGA, partial agonists, non-D<sub>2</sub>) and by depot availability.
4. **Administration routes.** Five routes (IV, short-acting IM, orodispersible, oral, long-acting injectable) compared by onset, time to peak and bioavailability, with onset bars for the selected drug and a clinical detail card per route.
5. **Pharmacodynamics.** Occupancy-concentration curves for every target, the dopamine concentration-response with and without the drug (antagonism and partial agonism), a radar of affinity (pKᵢ) and plasma potency (pEC<sub>50</sub>) on a log<sub>10</sub> scale with a ring at the plasma level of the usual dose (two layers for xanomeline and trospium), and striatal D<sub>2</sub> occupancy by daily dose with the PET thresholds.
6. **Pharmacokinetics.** One-compartment simulation with chains of active metabolites, depot products with their own release profiles (delayed release, double peaks) and co-formulated trospium; single and repeated doses, patient factors and interactions (CYP2D6, CYP3A4, CYP1A2, smoking, older adults, renal impairment), derived parameters, duration comparison and the main biotransformation pathways.
7. **Safety and monitoring.** Monitoring commonly recommended (metabolic, movement disorders, prolactin, cardiac, clozapine-specific, neuroleptic malignant syndrome) and the FDA boxed warning on increased mortality in older adults with dementia-related psychosis.

## 6. Models

Fractional occupancy of the drug ($C$) in competition with dopamine:

$$\theta = \frac{C / K_i}{1 + C / K_i + [\mathrm{DA}] / K_{\mathrm{DA}}}$$

Receptor signaling ($\alpha$ = intrinsic activity: 0 for an antagonist, between 0 and 1 for a partial agonist) and functional blockade, the quantity compared with the PET occupancy thresholds:

$$E = \frac{[\mathrm{DA}] / K_{\mathrm{DA}} + \alpha \, C / K_i}{1 + C / K_i + [\mathrm{DA}] / K_{\mathrm{DA}}}, \qquad B = \theta \,(1 - \alpha)$$

Plasma concentration of the D<sub>2</sub>-active moiety to free concentration, calibrated per drug so that $C_p = \mathrm{EC_{50}}$ gives 50 % D<sub>2</sub> occupancy at tonic dopamine (drugs without D<sub>2</sub> binding use the unbound plasma concentration); the plasma EC<sub>50</sub> at each other target follows from its Kᵢ:

$$C = K_i \left(1 + \frac{[\mathrm{DA}]_{\text{tonic}}}{K_{\mathrm{DA}}}\right) \frac{C_p}{\mathrm{EC_{50}}}$$

Pharmacokinetics (extravascular dose with a chain of metabolites, $j$ formed from $i$ with fraction $f_m$):

$$\frac{dA_{\text{depot},p}}{dt} = r_p(t) - k_{a,p} A_{\text{depot},p}, \qquad \frac{dA_{\text{c}}}{dt} = \sum_p k_{a,p} A_{\text{depot},p} - k_e A_{\text{c}}, \qquad \frac{dA_j}{dt} = f_{m,j} \, k_i A_i - k_j A_j$$

Each release phase $p$ of a dose delivers its fraction $f_p$ at once after a lag or at a constant rate $r_p = f_p F D / T_p$ over a release window $T_p$; oral doses have a single phase released at once. Depot products (e.g. Risperdal Consta, Okedi, Xeplion) have phases fitted to their labels, and their initiation regimens (loading injections, oral overlap) are simulated separately and added; for depot injections $k_a \ll k_e$, so the terminal slope reflects release (flip-flop kinetics). The assumptions behind each model are described in Notes & limitations in the app and in `meta` of `properties.json`.

## 7. Disclaimer

For education only. Parameters are rounded literature values for teaching receptor theory and clinical pharmacology; reported Kᵢ values for the same drug and receptor often differ several-fold between laboratories. The app is not intended for dose calculations or clinical decisions.

## 8. Use of AI

The application code, the data-checking scripts, the Swedish translation and parts of the explanatory texts were developed with the assistance of generative AI (Claude, Anthropic). The author selected the content, verified the pharmacological values against the cited sources (`references` and `sources` in `assets/data/properties.json`) and is responsible for the work.

## 9. License

Copyright © 2026 [impressio](https://github.com/impressio). All rights reserved. The website and source code may be viewed, and the repository cloned or downloaded for private study, teaching and evaluation; copying, modification, redistribution or hosting requires prior written permission. Third-party material keeps its own terms (Guide to Pharmacology and ChEMBL data, PubChem, FDA labels, FASS and EMA texts, the model data listed in the NOTICE files, and the CDN libraries). See [LICENSE](LICENSE).
