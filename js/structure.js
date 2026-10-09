/* =====================================================================
 * structure.js - Rotatable D2 dopamine receptor (PDB 6CM4, 3Dmol.js)
 *
 *  - Default look mimics a cryo-EM / crystallographic figure: a simulated
 *    density map computed per domain from the atomic model, with a window cut
 *    over the orthosteric pocket so the ball-and-stick ligand stays visible,
 *    and a translucent lipid bilayer disc around the transmembrane bundle.
 *  - "Ribbons" switches to cartoon with the seven transmembrane helices
 *    colored individually; "cut-away" removes the front helices (TM4-TM5) so
 *    the pocket and the intracellular cavity are visible.
 *  - The ligand follows the drug selected in the app: risperidone and
 *    haloperidol are shown in their own experimental poses, dopamine in the
 *    pose from the active-state complex, and every other drug on the
 *    risperidone pose as a template.
 *  - Receptor state follows the model: when D2 signaling is active the
 *    structure morphs toward the active conformation (outward swing of the
 *    intracellular half of TM6 and opening of the Gαi/o cavity), interpolated
 *    between the inactive template and the superposed active-state
 *    coordinates in assets/models/d2-poses.json.
 *  - Clicking a helix, the ligand, the pocket or the intracellular face shows
 *    details in the info panel.
 * ===================================================================== */
window.Structure = (function () {
  'use strict';

  let viewer = null;
  let loaded = false;
  let baseModel = null;        // receptor + risperidone (6CM4)
  let ligModel = null;         // haloperidol / dopamine poses (superposed)
  let poses = null;            // d2-poses.json
  let atomsOrig = [];          // template coordinates, by atom index
  let activeByKey = null;      // "resi:name" -> active-state coordinates

  let hasSurface = true;       // density-map mode (vs ribbons)
  let densityShapes = {};      // domain -> isosurface shape
  let ligandShape = null;      // translucent ligand density
  let ligandKeyShown = '';
  let membraneShapes = [];
  let isCut = false;
  let cutHelices = [];
  let zoomRef = null;
  let selectedHelix = 3;
  let pickAtoms = [];
  let nearLigand = new Set();
  let currentState = null;
  let isVisible = true;

  // Morph state
  let activation = 0;          // 0 = inactive template, 1 = active state
  let targetActivation = 0;
  let morphId = null;
  let shownLigand = '';
  let movingDomains = [];

  const PALETTE = {
    tm: { 1: '#74C0FC', 2: '#4DABF7', 3: '#3B6FD8', 4: '#A5D8FF', 5: '#1C7ED6', 6: '#5F3DC4', 7: '#9775FA', 8: '#CED4DA' },
    ecd: '#DEE2E6',
    ligand: '#8E4EC6',
    dopamine: '#E67700',
    gi: '#0B7285',
    pocket: '#C2255C',
  };

  /* Transmembrane helices (residue ranges) and the extracellular/intracellular loop regions */
  const TM = { 1: [35, 60], 2: [68, 96], 3: [104, 138], 4: [149, 172], 5: [186, 216], 6: [366, 398], 7: [405, 430] };
  const H8 = [431, 443];
  const helixOf = (resi) => {
    for (const [h, [lo, hi]] of Object.entries(TM)) if (resi >= lo && resi <= hi) return +h;
    return resi >= H8[0] && resi <= H8[1] ? 8 : 0;
  };
  /** Residues lining the orthosteric pocket (Ballesteros-Weinstein positions in superscript) */
  const POCKET_RESI = [114, 118, 189, 193, 194, 197, 386, 389, 390, 410, 413, 414];
  const GI_RESI = [131, 132, 135, 379, 382, 383, 386];   // DRY motif region and TM6 intracellular end

  function waitFor3Dmol(cb, maxRetries = 60) {
    if (typeof $3Dmol !== 'undefined') { cb(); return; }
    let count = 0;
    const interval = setInterval(() => {
      count++;
      if (typeof $3Dmol !== 'undefined') { clearInterval(interval); cb(); }
      else if (count >= maxRetries) { clearInterval(interval); console.warn('3Dmol library took too long to load.'); }
    }, 100);
  }

  function init() {
    const container = document.getElementById('mol-viewer');
    if (!container) return;
    if (window.Receptor && typeof window.Receptor.getState === 'function') currentState = window.Receptor.getState();

    new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        isVisible = entry.isIntersecting;
        if (entry.isIntersecting && !loaded) waitFor3Dmol(() => load(container));
      });
    }, { rootMargin: '200px' }).observe(container);

    attachPicking(container);
    // frame heights: once the fonts are in, and again after resizing
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => setTimeout(fitHeight, 0));
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitHeight, 150); });
    document.addEventListener('visibilitychange', () => { isVisible = !document.hidden; });
    attachButtons();
    attachZoomSlider();
    updateStatus();
  }

  function load(container) {
    if (loaded) return;
    if (typeof $3Dmol === 'undefined') { waitFor3Dmol(() => load(container)); return; }
    loaded = true;
    container.innerHTML = `<div class="mol-loading">${AP.t('st.loading')}</div>`;

    try {
      viewer = $3Dmol.createViewer(container, { defaultcolors: $3Dmol.rasmolElementColors, backgroundColor: '#ffffff' });
      Promise.all([ModelFiles.text('6CM4.pdb.gz'), ModelFiles.json('d2-poses.json')]).then(([pdb, data]) => {
        poses = data;
        viewer.addModel(pdb, 'pdb');
        try {
          onLoaded();
          container.querySelector('.mol-loading')?.remove();
        } catch (err) {
          console.error('Error processing the 6CM4 structure:', err);
        }
      }).catch(err => {
        console.warn('structure loading failed:', err);
        container.innerHTML = `<div class="mol-loading">${AP.t('st.loadError', { reason: err.message })}</div>`;
      });
    } catch (err) {
      console.warn('3Dmol loading failed:', err);
      container.innerHTML = `<div class="mol-loading">${AP.t('st.viewerError', { reason: err.message })}</div>`;
    }
  }

  function onLoaded() {
    baseModel = viewer.getModel(0);
    const atoms = baseModel.selectedAtoms({});
    atomsOrig = atoms.map(a => ({ index: a.index, x: a.x, y: a.y, z: a.z }));
    activeByKey = new Map((poses.active || []).map(([resi, name, x, y, z]) => [`${resi}:${name}`, [x, y, z]]));
    // Only the domains that actually move need re-contouring while the structure morphs;
    // TM1-TM4 form the rigid core the two structures were superposed on.
    movingDomains = [...new Set((poses.active || []).map(([resi]) => helixOf(resi)))];

    buildLigandModel();
    indexAtoms(atoms);
    viewer.setViewStyle({ style: 'outline', color: '#1f2937', width: 0.035 });
    addDensityMap();
    applyStyling();
    drawMembrane();

    viewer.zoomTo();
    setSideView();
    viewer.setViewChangeCallback(() => syncZoomSlider());
    viewer.render();
    updateStatus();
  }

  /** Haloperidol and dopamine poses as their own model (hidden unless selected) */
  function buildLigandModel() {
    const lines = [];
    let serial = 1;
    const push = (resn, chain, resi, atomsArr) => atomsArr.forEach(([el, x, y, z]) => {
      lines.push('HETATM' + String(serial++).padStart(5, ' ') + ' ' + (el + serial).slice(0, 4).padEnd(4, ' ') + ' ' +
        resn.padEnd(3, ' ') + ' ' + chain + String(resi).padStart(4, ' ') + '    ' +
        x.toFixed(3).padStart(8, ' ') + y.toFixed(3).padStart(8, ' ') + z.toFixed(3).padStart(8, ' ') +
        '  1.00 30.00          ' + el.padStart(2, ' '));
    });
    push('HAL', 'L', 1, poses.haloperidol || []);
    push('DAN', 'L', 2, poses.dopamine || []);
    lines.push('END');
    ligModel = viewer.addModel(lines.join('\n'), 'pdb');
    ligModel.setStyle({}, {});
  }

  /** Atoms used for click picking, and receptor atoms near the ligand (density window) */
  function indexAtoms(atoms) {
    const lig = atoms.filter(a => a.hetflag)
      .concat((poses.haloperidol || []).map(([, x, y, z]) => ({ x, y, z })))
      .concat((poses.dopamine || []).map(([, x, y, z]) => ({ x, y, z })));
    pickAtoms = atoms.filter(a => a.atom === 'CA' || a.hetflag)
      .concat((poses.dopamine || []).map(([, x, y, z]) => ({ x, y, z, hetflag: true, resn: 'DAN' })));
    const W2 = 8 * 8;
    atoms.forEach(a => {
      if (a.hetflag) return;
      for (const l of lig) {
        const dx = a.x - l.x, dy = a.y - l.y, dz = a.z - l.z;
        if (dx * dx + dy * dy + dz * dz < W2) { nearLigand.add(a.index); break; }
      }
    });
  }

  /* ---------- Simulated density map ---------- */
  const MAP = { spacing: 0.9, sigma: 1.7, iso: 1.1, smooth: 4 };

  function gaussianVolume(atoms, pad) {
    const { spacing: h, sigma } = MAP;
    const xs = atoms.map(a => a.x), ys = atoms.map(a => a.y), zs = atoms.map(a => a.z);
    const o = { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, z: Math.min(...zs) - pad };
    const size = {
      x: Math.ceil((Math.max(...xs) + pad - o.x) / h) + 1,
      y: Math.ceil((Math.max(...ys) + pad - o.y) / h) + 1,
      z: Math.ceil((Math.max(...zs) + pad - o.z) / h) + 1,
    };
    const data = new Float32Array(size.x * size.y * size.z);
    const inv = 1 / (2 * sigma * sigma), cut = 3 * sigma, c2 = cut * cut, r = Math.ceil(cut / h);
    const syz = size.y * size.z;
    for (const a of atoms) {
      const ci = Math.round((a.x - o.x) / h), cj = Math.round((a.y - o.y) / h), ck = Math.round((a.z - o.z) / h);
      for (let i = Math.max(0, ci - r); i <= Math.min(size.x - 1, ci + r); i++) {
        const dx = o.x + i * h - a.x;
        for (let j = Math.max(0, cj - r); j <= Math.min(size.y - 1, cj + r); j++) {
          const dy = o.y + j * h - a.y, dxy = dx * dx + dy * dy;
          if (dxy > c2) continue;
          const row = i * syz + j * size.z;
          for (let k = Math.max(0, ck - r); k <= Math.min(size.z - 1, ck + r); k++) {
            const dz = o.z + k * h - a.z, d2 = dxy + dz * dz;
            if (d2 < c2) data[row + k] += Math.exp(-d2 * inv);
          }
        }
      }
    }
    const vd = new $3Dmol.VolumeData('', 'none');
    vd.size = size; vd.origin = o; vd.unit = { x: h, y: h, z: h }; vd.data = data; vd.matrix = null;
    return vd;
  }

  /** Density is contoured per helix (plus one map for the loops) so it can be colored by domain */
  const DOMAINS = [1, 2, 3, 4, 5, 6, 7, 8, 0];

  function addDomainDensity(dom) {
    if (densityShapes[dom]) viewer.removeShape(densityShapes[dom]);
    delete densityShapes[dom];
    if (cutHelices.includes(dom)) return;
    const atoms = baseModel.selectedAtoms({}).filter(a =>
      !a.hetflag && a.elem !== 'H' && helixOf(a.resi) === dom && !nearLigand.has(a.index));
    if (!atoms.length) return;
    const c = dom === 0 ? PALETTE.ecd : PALETTE.tm[dom];
    densityShapes[dom] = viewer.addIsosurface(gaussianVolume(atoms, 5), {
      isoval: MAP.iso, smoothness: MAP.smooth, opacity: 1,
      color: dom === selectedHelix ? lighten(c, 0.25) : c,
    });
  }

  function addDensityMap() {
    if (!viewer || !baseModel) return;
    const t0 = performance.now();
    hasSurface = true;
    DOMAINS.forEach(addDomainDensity);
    console.info(`[structure] density map contoured in ${Math.round(performance.now() - t0)} ms`);
    ligandKeyShown = '';
    updateLigandDensity();
    const btn = document.getElementById('mol-btn-surface');
    if (btn) { btn.textContent = AP.t('mechanism.ribbons'); btn.title = AP.t('mechanism.ribbonsTip'); }
  }

  function removeDensityMap() {
    Object.values(densityShapes).forEach(sh => viewer.removeShape(sh));
    if (ligandShape) viewer.removeShape(ligandShape);
    densityShapes = {}; ligandShape = null; ligandKeyShown = '';
    hasSurface = false;
  }

  function lighten(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.round(v + (255 - v) * f);
    return '#' + ((1 << 24) + (ch(n >> 16) << 16) + (ch((n >> 8) & 255) << 8) + ch(n & 255)).toString(16).slice(1);
  }

  /** Which ligand occupies the pocket: dopamine, a named experimental pose, or the template pose */
  function occupant(state) {
    if (!state) return { kind: 'template', drug: AP.drugs.risperidone, color: AP.drugs.risperidone.color };
    const drug = state.drug;
    const drugIn = !!(drug && state.d2.occD > 0.05);
    const daIn = state.d2.occDA > 0.05;
    // The drug is shown whenever it occupies an appreciable fraction: both species are present
    // simultaneously on different receptors, and this section is about the drug.
    if (drugIn) {
      const key = state.ligandKey;
      const kind = key === 'haloperidol' ? 'haloperidol' : (key === 'risperidone' ? 'risperidone' : 'template');
      return { kind, drug, color: drug.color };
    }
    if (daIn) return { kind: 'dopamine', drug: null, color: PALETTE.dopamine };
    return { kind: null, drug: null, color: '#ced4da' };
  }

  /** Translucent density around the bound ligand */
  function updateLigandDensity() {
    if (!viewer || !baseModel || !hasSurface) return;
    const occ = occupant(currentState);
    const key = `${occ.kind}|${occ.drug ? occ.drug.name : ''}`;
    if (key === ligandKeyShown) return;
    ligandKeyShown = key;
    if (ligandShape) { viewer.removeShape(ligandShape); ligandShape = null; }
    let atoms = [];
    if (occ.kind === 'dopamine') atoms = (poses.dopamine || []).map(([, x, y, z]) => ({ x, y, z }));
    else if (occ.kind === 'haloperidol') atoms = (poses.haloperidol || []).map(([, x, y, z]) => ({ x, y, z }));
    else if (occ.kind) atoms = baseModel.selectedAtoms({ hetflag: true }).filter(a => a.elem !== 'H');
    if (atoms.length) {
      ligandShape = viewer.addIsosurface(gaussianVolume(atoms, 4), { isoval: 0.35, smoothness: 2, color: occ.color, opacity: 0.35 });
    }
  }

  /**
   * Lipid bilayer: a low-resolution disc around the transmembrane bundle, contoured like the
   * protein map and drawn translucent. Pore axis = z, extracellular = −z.
   */
  function drawMembrane() {
    if (!viewer) return;
    membraneShapes.forEach(sh => viewer.removeShape(sh));
    const R = 30, H = 15, h = 1.6;
    const o = { x: -R - 6, y: -R - 6, z: -H - 6 };
    const size = { x: Math.ceil((2 * R + 12) / h) + 1, y: Math.ceil((2 * R + 12) / h) + 1, z: Math.ceil((2 * H + 12) / h) + 1 };
    const data = new Float32Array(size.x * size.y * size.z);
    for (let i = 0; i < size.x; i++) for (let j = 0; j < size.y; j++) {
      const px = o.x + i * h, py = o.y + j * h, r = Math.hypot(px, py), ang = Math.atan2(py, px);
      const rim = R + 1.2 * Math.sin(ang * 7) + 0.8 * Math.cos(ang * 13);
      for (let k = 0; k < size.z; k++) {
        const dz = Math.abs(o.z + k * h);
        const wobble = 0.6 * Math.sin(px * 0.31 + py * 0.17) * Math.cos(py * 0.23 - px * 0.11);
        let v = Math.min(rim - r, H + wobble - dz);
        if (isCut) v = Math.min(v, -(px * cutNormal.x + py * cutNormal.y) - 2);
        data[(i * size.y + j) * size.z + k] = v;
      }
    }
    const vd = new $3Dmol.VolumeData('', 'none');
    vd.size = size; vd.origin = o; vd.unit = { x: h, y: h, z: h }; vd.data = data; vd.matrix = null;
    membraneShapes = [viewer.addIsosurface(vd, { isoval: 0, smoothness: 4, color: '#9ea7b2', opacity: 0.45 })];
  }
  let cutNormal = { x: 1, y: 0 };

  /* ---------- Styling ---------- */
  function applyStyling() {
    if (!viewer || !baseModel) return;
    viewer.setStyle({}, {});
    baseModel.setStyle({ resn: ['HOH', 'PEG', 'OLA', 'OLC', 'CLR'] }, {});

    if (!hasSurface) {
      // Cartoon colored per transmembrane helix, loops in gray
      baseModel.setStyle({ hetflag: false }, { cartoon: { color: PALETTE.ecd } });
      Object.entries(TM).forEach(([h, [lo, hi]]) => {
        if (cutHelices.includes(+h)) { baseModel.setStyle({ resi: `${lo}-${hi}` }, {}); return; }
        const c = PALETTE.tm[h];
        baseModel.setStyle({ resi: `${lo}-${hi}` }, { cartoon: { color: +h === selectedHelix ? lighten(c, 0.25) : c } });
      });
      baseModel.setStyle({ resi: `${H8[0]}-${H8[1]}` }, { cartoon: { color: PALETTE.tm[8] } });
      // Pocket and DRY-motif side chains as sticks
      baseModel.setStyle({ resi: POCKET_RESI }, { stick: { color: PALETTE.pocket, radius: 0.2 } }, true);
      baseModel.setStyle({ resi: [131, 132, 133] }, { stick: { color: PALETTE.gi, radius: 0.22 } }, true);
    }

    // Ligand: ball-and-stick with element colors
    const cpk = (carbon) => (atom) => {
      switch (atom.elem) {
        case 'N': return '#3050F8';
        case 'O': return '#E03131';
        case 'Cl': return '#2F9E44';
        case 'F': return '#74C69D';
        case 'S': return '#E3B341';
        default: return carbon;
      }
    };
    const ballStick = (carbon) => ({ sphere: { colorfunc: cpk(carbon), scale: 0.3 }, stick: { colorfunc: cpk(carbon), radius: 0.2 } });

    const occ = occupant(currentState);
    const tmplSel = { hetflag: true };
    if (ligModel) ligModel.setStyle({}, {});
    if (occ.kind === 'dopamine') {
      baseModel.setStyle(tmplSel, {});
      ligModel?.setStyle({ resn: 'DAN' }, ballStick(PALETTE.dopamine));
    } else if (occ.kind === 'haloperidol') {
      baseModel.setStyle(tmplSel, {});
      ligModel?.setStyle({ resn: 'HAL' }, ballStick(occ.color));
    } else if (occ.kind) {
      baseModel.setStyle(tmplSel, ballStick(occ.color || PALETTE.ligand));
    } else {
      baseModel.setStyle(tmplSel, { stick: { color: '#ced4da', radius: 0.15 } });
    }

    addLabels(occ);
    updateLigandDensity();
  }

  /**
   * Floating labels as HTML over the viewer, placed at the projected model coordinates on every view change:
   * the browser renders the text, so it stays sharp at any zoom (3Dmol labels are textures and blur).
   */
  let overlay = null, overlayLabels = [];
  function placeLabels() {
    if (!viewer || !overlay) return;
    // modelToScreen returns page coordinates (canvas offset on the page included): convert to the viewer box
    const r = overlay.parentElement.getBoundingClientRect(), ox = r.left + window.scrollX, oy = r.top + window.scrollY;
    overlayLabels.forEach(l => {
      const p = viewer.modelToScreen(l.pos);
      l.el.style.left = `${p.x - ox}px`; l.el.style.top = `${p.y - oy}px`;
    });
  }
  function addLabels(occ) {
    if (!viewer || !baseModel) return;
    const container = document.getElementById('mol-viewer');
    if (!overlay && container) {
      overlay = document.createElement('div');
      overlay.className = 'mol-labels';
      container.appendChild(overlay);
      viewer.setViewChangeCallback(placeLabels);
    }
    if (!overlay) return;
    overlay.innerHTML = ''; overlayLabels = [];
    const add = (text, pos, color) => {
      const el = document.createElement('span');
      el.className = 'mol-label'; el.textContent = text; el.style.borderColor = color;
      overlay.appendChild(el); overlayLabels.push({ el, pos });
    };
    const centroid = (sel) => {
      const a = baseModel.selectedAtoms(sel);
      if (!a.length) return null;
      return a.reduce((s, x) => ({ x: s.x + x.x / a.length, y: s.y + x.y / a.length, z: s.z + x.z / a.length }), { x: 0, y: 0, z: 0 });
    };

    const name = occ.kind === 'dopamine' ? AP.dopamine.name : (occ.drug ? occ.drug.name : AP.t('st.empty'));
    const ligAtoms = occ.kind === 'dopamine' ? (poses.dopamine || []).map(([, x, y, z]) => ({ x, y, z }))
      : occ.kind === 'haloperidol' ? (poses.haloperidol || []).map(([, x, y, z]) => ({ x, y, z }))
        : baseModel.selectedAtoms({ hetflag: true });
    if (ligAtoms.length) {
      const c = ligAtoms.reduce((s, x) => ({ x: s.x + x.x / ligAtoms.length, y: s.y + x.y / ligAtoms.length, z: s.z + x.z / ligAtoms.length }), { x: 0, y: 0, z: 0 });
      add(AP.t('st.pocketLabel', { ligand: name }), { x: c.x, y: c.y, z: c.z - 10 }, occ.color);
    }
    const asp = centroid({ resi: 114, atom: 'CA' });
    if (asp) add('Asp114 (3.32)', { x: asp.x - 6, y: asp.y, z: asp.z }, PALETTE.pocket);
    const gi = centroid({ resi: 131, atom: 'CA' });
    if (gi) add(AP.t('st.dryLabel'), { x: gi.x, y: gi.y, z: gi.z + 8 }, PALETTE.gi);
    const tm6 = centroid({ resi: 380, atom: 'CA' });
    if (tm6) add('TM6', { x: tm6.x, y: tm6.y, z: tm6.z }, PALETTE.tm[6]);
    placeLabels();
  }

  /* ---------- Inactive ⇄ active morph ---------- */

  /** Interpolate receptor coordinates between the template and the active state */
  function applyActivation(a) {
    if (!baseModel || !activeByKey) return;
    const atoms = baseModel.selectedAtoms({});
    atoms.forEach((at, i) => {
      const o = atomsOrig[i];
      if (!o) return;
      const t = activeByKey.get(`${at.resi}:${at.atom}`);
      if (!t) { at.x = o.x; at.y = o.y; at.z = o.z; return; }
      at.x = o.x + (t[0] - o.x) * a;
      at.y = o.y + (t[1] - o.y) * a;
      at.z = o.z + (t[2] - o.z) * a;
    });
  }

  /**
   * Conformation of the receptor that is actually displayed, i.e. the one with the ligand shown in
   * the pocket bound: dopamine stabilizes the active state, a neutral antagonist the inactive one,
   * and a partial agonist an equilibrium between them in proportion to its intrinsic activity.
   * (The receptor population as a whole is mixed; this shows one receptor, not the ensemble.)
   */
  function activationFor(state) {
    const occ = occupant(state);
    if (occ.kind === 'dopamine') return 1;
    if (!occ.kind) return 0;                       // empty pocket: inactive
    return occ.drug ? Models.ia(occ.drug, 'd2') : 0;
  }

  /**
   * Animate toward an activation level. Re-contouring the density map is expensive (nine
   * isosurfaces), so in map mode the geometry is rebuilt at most every REBUILD_MS and always
   * once the morph settles; ribbon mode is cheap enough to follow every frame.
   */
  const MORPH_MS = 600;        // duration of the inactive ⇄ active transition
  const REBUILD_MS = 90;       // minimum interval between geometry rebuilds while morphing
  let morphFrom = 0, morphStart = 0, lastRebuild = 0, morphTimer = null;

  /** Snap to the end state and draw it once: used when the morph finishes, and by the fallback */
  function finishMorph() {
    if (morphId) { cancelAnimationFrame(morphId); morphId = null; }
    if (morphTimer) { clearTimeout(morphTimer); morphTimer = null; }
    activation = targetActivation;
    applyActivation(activation);
    if (hasSurface) DOMAINS.forEach(addDomainDensity);
    applyStyling();
    viewer.render();
    updateStatus();
  }

  function morphTo(a) {
    const next = Math.max(0, Math.min(1, a));
    if (Math.abs(next - targetActivation) < 0.005 && !morphId) return;
    targetActivation = next;
    morphFrom = activation;
    morphStart = performance.now();

    // Animation frames stop in a hidden tab and are starved in some headless environments, so a
    // timer guarantees the structure and the readout reach the end state even without them.
    if (morphTimer) clearTimeout(morphTimer);
    morphTimer = setTimeout(finishMorph, MORPH_MS + 250);
    if (morphId) return;

    const step = () => {
      const now = performance.now();
      const u = Math.min(1, (now - morphStart) / MORPH_MS);   // time-based, so the transition
      const eased = u * u * (3 - 2 * u);                       // takes the same time at any frame rate
      activation = morphFrom + (targetActivation - morphFrom) * eased;
      morphId = u >= 1 ? null : requestAnimationFrame(step);
      if (u >= 1) { finishMorph(); return; }
      applyActivation(activation);
      if (now - lastRebuild > REBUILD_MS) {
        lastRebuild = now;
        if (hasSurface) movingDomains.forEach(addDomainDensity);
        applyStyling();
        viewer.render();
        updateStatus();          // the readout follows the morph instead of lagging behind it
      }
    };
    morphId = requestAnimationFrame(step);
  }

  /* ---------- Views ---------- */
  function resetLookAt() {
    if (viewer && viewer.lookingAt && viewer.camera) { viewer.lookingAt.set(0, 0, 0); viewer.camera.lookAt(viewer.lookingAt); }
  }

  const REF_HEIGHT = 564;   // px: viewer height at which the default zoom factor applies

  function setSideView() {
    if (!viewer) return;
    resetLookAt();
    viewer.setView([0, 0, 0, 0, 0, 0, 0, 1]);
    viewer.zoomTo();
    // membrane normal (z) vertical, extracellular side up
    viewer.rotate(90, 'x');
    const el = document.getElementById('mol-viewer');
    const vw = el?.clientWidth || 640, vh = el?.clientHeight || REF_HEIGHT;
    // default size (10 % below the earlier 1.35); the perspective fit scales with the viewer height, so the
    // zoom is divided by it: the receptor keeps the same size when the frame is taller (e.g. Swedish texts)
    viewer.zoom(1.215 * Math.min(1, Math.max(0.85, vw / 620)) * REF_HEIGHT / vh);
    viewer.translate(0, vw < 500 ? 26 : 12);
    zoomRef = viewer.CAMERA_Z - viewer.getView()[3];
    syncZoomSlider();
    viewer.render();
    placeLabels();
  }

  /** Model-space unit vector pointing from the receptor toward the camera */
  function towardCamera() {
    const v = viewer.getView(), q = { x: -v[4], y: -v[5], z: -v[6], w: v[7] };
    const px = 0, py = 0, pz = 1;
    const ix = q.w * px + q.y * pz - q.z * py, iy = q.w * py + q.z * px - q.x * pz;
    const iz = q.w * pz + q.x * py - q.y * px, iw = -q.x * px - q.y * py - q.z * pz;
    const r = {
      x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
      y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
      z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
    };
    const l = Math.hypot(r.x, r.y, r.z) || 1;
    return { x: r.x / l, y: r.y / l, z: r.z / l };
  }

  /** Cut-away: remove the two helices nearest the camera so the pocket is visible */
  function setCut(on) {
    const btn = document.getElementById('mol-btn-cut');
    isCut = on;
    if (on) {
      const n = towardCamera();
      cutNormal = n;
      const score = Object.keys(TM).map(h => {
        const ca = baseModel.selectedAtoms({ resi: `${TM[h][0]}-${TM[h][1]}`, atom: 'CA' });
        if (!ca.length) return { h: +h, d: -Infinity };
        const c = ca.reduce((acc, a) => ({ x: acc.x + a.x / ca.length, y: acc.y + a.y / ca.length }), { x: 0, y: 0 });
        return { h: +h, d: c.x * n.x + c.y * n.y };
      }).sort((p, q) => q.d - p.d);
      cutHelices = score.slice(0, 2).map(e => e.h);
    } else {
      cutHelices = [];
    }
    if (hasSurface) DOMAINS.forEach(addDomainDensity);
    applyStyling();
    drawMembrane();
    if (btn) {
      btn.textContent = AP.t(on ? 'mechanism.whole' : 'mechanism.cut');
      btn.title = AP.t(on ? 'mechanism.wholeTip' : 'mechanism.cutTip');
    }
    viewer.render();
  }

  /* ---------- Picking ---------- */
  function attachPicking(container) {
    let down = null;
    container.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; }, true);
    container.addEventListener('pointerup', (e) => {
      if (!down || !viewer || !pickAtoms.length) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      const mx = e.pageX, my = e.pageY;
      const scr = viewer.modelToScreen(pickAtoms.map(a => ({ x: a.x, y: a.y, z: a.z })));
      const v = viewer.getView();
      const q = { x: v[4], y: v[5], z: v[6], w: v[7] };
      const depth = (a) => {
        const px = a.x + v[0], py = a.y + v[1], pz = a.z + v[2];
        const ix = q.w * px + q.y * pz - q.z * py, iy = q.w * py + q.z * px - q.x * pz;
        const iz = q.w * pz + q.x * py - q.y * px, iw = -q.x * px - q.y * py - q.z * pz;
        return iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
      };
      let best = null, bestD = -Infinity, lig = null, ligD = -Infinity;
      pickAtoms.forEach((a, i) => {
        const p = scr[i];
        if (!p) return;
        const d2 = (p.x - mx) ** 2 + (p.y - my) ** 2;
        if (d2 > 26 * 26) return;
        const z = depth(a);
        if (a.hetflag) { if (z > ligD) { lig = a; ligD = z; } }
        else if (d2 < 14 * 14 && z > bestD) { best = a; bestD = z; }
      });
      if (!window.Receptor) return;
      if (lig && ligD > bestD - 18) {
        window.Receptor.showInfo(occupant(currentState).kind === 'dopamine' ? 'dopamine' : 'pocket');
      } else if (best) {
        const h = helixOf(best.resi);
        selectedHelix = h;
        if (hasSurface) { DOMAINS.forEach(addDomainDensity); } else { applyStyling(); }
        viewer.render();
        window.Receptor.showInfo(POCKET_RESI.includes(best.resi) ? 'pocket' : (GI_RESI.includes(best.resi) || best.resi > 370 && best.resi < 400 ? 'gi' : 'pathway'));
      } else {
        window.Receptor.showInfo('pathway');
      }
    });
  }

  /* ---------- Toolbar ---------- */
  function attachButtons() {
    document.querySelectorAll('button[data-mol]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-mol');
        if (!viewer) {
          const container = document.getElementById('mol-viewer');
          if (container && !loaded) waitFor3Dmol(() => load(container));
          return;
        }
        switch (action) {
          case 'reset': setSideView(); break;
          case 'top':
            resetLookAt();
            viewer.setView([0, 0, 0, 0, 0, 0, 0, 1]);
            viewer.zoomTo();
            viewer.rotate(180, 'x');   // look down the bundle from the extracellular side
            syncZoomSlider();
            viewer.render();
            break;
          case 'cut': setCut(!isCut); break;
          case 'pocket':
            viewer.zoomTo({ resi: POCKET_RESI });
            viewer.zoom(0.55);
            syncZoomSlider();
            viewer.render();
            break;
          case 'gi':
            viewer.zoomTo({ resi: [131, 132, 133, 379, 382, 383] });
            viewer.zoom(0.5);
            syncZoomSlider();
            viewer.render();
            break;
          case 'surface': toggleSurface(); break;
          case 'state': {
            stateOverride = stateOverride === null ? (activation > 0.5 ? 0 : 1) : (stateOverride > 0.5 ? 0 : 1);
            morphTo(stateOverride);
            refreshStateButton();
            break;
          }
        }
      });
    });
  }
  let stateOverride = null;

  function refreshStateButton() {
    const btn = document.getElementById('mol-btn-state');
    if (!btn) return;
    const active = (stateOverride === null ? activation : stateOverride) > 0.5;
    btn.textContent = AP.t(active ? 'mechanism.inactiveState' : 'mechanism.activeState');
    btn.title = AP.t(active ? 'mechanism.inactiveStateTip' : 'mechanism.activeStateTip');
    btn.classList.toggle('on', stateOverride !== null);
  }

  function toggleSurface() {
    if (!viewer) return;
    const btn = document.getElementById('mol-btn-surface');
    if (hasSurface) {
      removeDensityMap();
      applyStyling();
      if (btn) { btn.textContent = AP.t('mechanism.densityMap'); btn.title = AP.t('mechanism.densityMapTip'); }
    } else {
      addDensityMap();
      applyStyling();
    }
    viewer.render();
  }

  /* ---------- Status panel ---------- */
  function updateStatus() {
    const panel = document.getElementById('mol-status');
    if (!panel) return;
    const s = currentState || (window.Receptor ? window.Receptor.getState() : null);
    if (!s) { panel.innerHTML = `<span class="muted">${AP.t('st.awaiting')}</span>`; return; }
    panel.innerHTML = statusHtml(s, activation);
    const dot = document.querySelector('#mol-legend-ligand .dot');
    if (dot) dot.style.background = occupant(s).color;
  }

  /** HTML of the status panel for a state and displayed activation (also used to measure the tallest panel) */
  function statusHtml(s, activation) {

    const drug = s.drug;
    const occD = s.d2.occD * 100, occDA = s.d2.occDA * 100;
    const signal = s.d2.signal * 100, base = s.d2.base * 100;
    const iaD2 = drug ? Models.ia(drug, 'd2') : 0;
    const occ = occupant(s);

    const pct = (x) => AP.fmt(x);
    const pill = (bg, label) => `<span class="mol-status-pill" style="background:${bg}">${label}</span>`;
    let badge, text;
    if (!drug) {
      badge = pill(PALETTE.dopamine, AP.t('st.daOnly'));
      text = AP.t('st.daOnlyText', { occ: pct(occDA), da: AP.fmt(s.da) });
    } else if (occD < 5) {
      badge = pill('#868e96', AP.t('st.notBound', { drug: drug.name }));
      text = AP.t('st.notBoundText', { drug: drug.name.toLowerCase() });
    } else if (iaD2 > 0) {
      badge = pill(drug.color, AP.t('st.partialAgonist', { drug: drug.name }));
      text = AP.t('st.partialAgonistText', { occ: pct(occD), ia: pct(iaD2 * 100) });
    } else {
      badge = pill(drug.color, AP.t('st.antagonist', { drug: drug.name }));
      text = AP.t('st.antagonistText', { occ: pct(occD), occDA: pct(occDA) });
    }
    const ligandName = occ.kind === 'dopamine' ? AP.dopamine.name : (occ.drug ? occ.drug.name : AP.t('st.empty'));
    const confKey = activation > 0.6 ? 'st.confActive' : activation > 0.1 ? 'st.confIntermediate' : 'st.confInactive';

    return `
      <div class="mol-status-head">
        <div>${AP.t('st.pocket', { ligand: ligandName })}</div>
        ${badge}
      </div>
      <div class="mol-status-metrics">
        <div class="mol-status-m full">
          <span>${AP.t('mechanism.signaling')}</span>
          <b style="color:${PALETTE.gi}">${AP.t('st.ofMax', { pct: pct(signal) })}</b>
          <small>${base > 0 ? AP.t('mechanism.relDopamine', { pct: pct(signal / base * 100), base: `${pct(base)} %` }) : AP.t('mechanism.noDopamine')}</small>
        </div>
        <div class="mol-status-m">
          <span>${AP.t('st.confTitle')}</span>
          <b>${AP.t(confKey)}</b>
          <small>${AP.t('st.confMorph', { pct: pct(activation * 100), ligand: occ.kind ? ligandName.toLowerCase() : AP.t('st.nothing') })}</small>
        </div>
      </div>
      <div class="mol-status-text">${text}</div>
    `;
  }

  /**
   * Three-column layout: give the viewer the height at which the middle frame is as tall as the right
   * frame can become (tallest info topic plus tallest status over all drugs, unbound and half-occupied,
   * and pathways), measured on a hidden copy of the right frame, so the frames do not change height.
   */
  function fitHeight() {
    const card = document.querySelector('.mech-card');
    const info = card && card.querySelector('.illo-info'), stage = card && card.querySelector('.illo-stage');
    const el = document.getElementById('mol-viewer');
    if (!info || !stage || !el || !window.Receptor || !window.Receptor.stateFor) return;
    el.style.height = '';
    if (window.matchMedia('(max-width: 1100px)').matches) { if (viewer) { viewer.resize(); if (loaded && baseModel) setSideView(); } return; }
    const probe = document.createElement('div');
    probe.className = info.className;
    probe.style.cssText = `position:absolute; left:-10000px; top:0; visibility:hidden; height:auto; width:${info.getBoundingClientRect().width}px`;
    probe.innerHTML = '<div class="subinfo"></div><div class="mol-status-panel"></div>';
    card.appendChild(probe);
    const [sub, status] = probe.children;
    const tallest = (box, htmls) => htmls.reduce((best, h) => { box.innerHTML = h; const y = box.offsetHeight; return y > best.y ? { y, h } : best; }, { y: -1, h: '' }).h;
    const paths = Object.keys(AP.pathways);
    const states = [];
    paths.forEach(pk => {
      states.push(window.Receptor.stateFor('none', pk, 0));
      Object.entries(AP.drugs).forEach(([k, d]) => {
        states.push(window.Receptor.stateFor(k, pk, 0));
        if (!(d.pd.ki.d2 >= AP.NB)) states.push(window.Receptor.stateFor(k, pk, (d.pd.ki.d2 ?? 1) * (1 + AP.pathways[pk].da / AP.DA.K)));
      });
    });
    sub.innerHTML = tallest(sub, ['pocket', 'dopamine', 'gi'].map(t => window.Receptor.infoHtml(t, states[0]))
      .concat(paths.map(pk => window.Receptor.infoHtml('pathway', window.Receptor.stateFor('none', pk, 0)))));
    status.innerHTML = tallest(status, states.map(st => statusHtml(st, activationFor(st))));
    const target = probe.offsetHeight;
    probe.remove();
    stage.style.alignSelf = 'start';
    const natural = stage.offsetHeight;
    stage.style.alignSelf = '';
    el.style.height = `${Math.max(360, el.offsetHeight + target - natural)}px`;
    if (viewer) { viewer.resize(); if (loaded && baseModel) setSideView(); else viewer.render(); }
  }

  /** Called by the Receptor module whenever controls change */
  function setState(newState) {
    currentState = newState;
    if (loaded && viewer) {
      const occ = occupant(newState);
      const ligKey = `${occ.kind}|${occ.drug ? occ.drug.name : ''}`;
      if (ligKey !== shownLigand) { shownLigand = ligKey; applyStyling(); viewer.render(); }
      if (stateOverride === null) morphTo(activationFor(newState));
      refreshStateButton();
    }
    updateStatus();
  }

  /* ---------- Zoom ---------- */
  function attachZoomSlider() {
    const el = document.getElementById('mol-zoom');
    el?.addEventListener('input', () => {
      if (!viewer || !zoomRef) return;
      const level = Math.pow(2, parseFloat(el.value));
      const v = viewer.getView();
      v[3] = viewer.CAMERA_Z - zoomRef / level;
      viewer.setView(v);
      updateZoomLabel(level);
    });
  }

  function syncZoomSlider() {
    const el = document.getElementById('mol-zoom');
    if (!el || !viewer || !zoomRef) return;
    const level = zoomRef / Math.max(1e-3, viewer.CAMERA_Z - viewer.getView()[3]);
    el.value = Math.log2(level).toFixed(2);
    updateZoomLabel(level);
  }

  function updateZoomLabel(level) {
    const lbl = document.getElementById('mol-zoom-val');
    if (lbl) lbl.textContent = `${AP.fmt(level, 1)}×`;
  }

  return { init, setState, toggleSurface, fitHeight, getViewer: () => viewer };
})();
