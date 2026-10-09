/* =====================================================================
 * distribution.js - Regional brain distribution of the receptor targets
 *
 * Viewer stage in the style of the receptor viewer (title, stage, badge, zoom,
 * floating toolbar, legend) with a 3D brain (brain3d.js, three.js) and a 2D map
 * rendered offline from the same meshes (assets/models/brain-2d-*.png), colored
 * here on a canvas so it needs no WebGL. Relative abundance 0-3 per region is a
 * qualitative summary (stored in assets/data/properties.json) of immunohistochemistry and in situ hybridization in
 * rodent brain (Pirker et al. 2000; Fritschy & Mohler 1995), consistent with
 * human autoradiography and PET where available. The target shown is the global
 * target selection (window.syncTargetSelection).
 * ===================================================================== */
window.Distribution = (function () {
  'use strict';

  let ORDER = [];
  /* Regional abundance from assets/data/properties.json (AP.regions): level names, region names, the
   * target order and, per target and region, the relative abundance (0-3) with the cell populations concerned.
   * Filled by readRegions() when the module starts. */
  let LEVEL = [], REGIONS = {}, DIST = {};
  function readRegions() {
    const R = AP.regions;
    ORDER = R.order;
    LEVEL = R.levels;
    REGIONS = Object.fromEntries(Object.entries(R.names).map(([k, name]) => [k, { name }]));
    DIST = Object.fromEntries(Object.entries(R.abundance).map(([iso, regs]) =>
      [iso, Object.fromEntries(Object.entries(regs).map(([r, v]) => [r, [v.level, v.note, v.activation, v.blockade, v.pathway]]))]));
  }

  const OPACITY = [0, 0.4, 0.65, 0.9];
  let current = 'd2';
  let mode = '3d';          // '3d' | '2d'
  let has3d = false;
  let zoom2d = 1;
  let view2d = null;        // { L: {w,h,pix,anchors}, R: {...} } once loaded
  let selected = null;      // region key selected in the list, 3D model or 2D map

  /* Dopaminergic pathways overlay (geometry in AP.pathways[*].geometry, MNI mm). Colors are presentation. */
  const PATH_COLORS = { mesolimbic: '#e8590c', mesocortical: '#f59f00', nigrostriatal: '#c2255c', tuberoinfundibular: '#0b7285' };
  const PATH_ORDER = Object.keys(PATH_COLORS);   // anatomical order for chips and legend
  const paths = { on: true, selected: null };
  let mniT = null;          // MNI -> model transform (brain-mesh.json), also needed without WebGL
  let path2d = [];          // projected, smoothed polylines of the current 2D view: { key, pts: [[x,y]...] } in image px

  /** Same color as the badge of the target card */
  function cardColor(k) {
    return AP.targets[k].color || '#5b8def';
  }
  function rgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const FRONT_ALPHA = 0.55; // opacity of structures in the translucent half in the 2D map
  const SELECT_COLOR = '#e03131'; // selected structure in the 3D model and 2D map (the list frame uses the app accent)
  const css = (c) => `rgb(${c.map(v => Math.round(v)).join(',')})`;
  /** Tissue color of a region tinted by the target color at the given abundance level */
  const regionColor = (region, lvl, color) => mix(rgb(TISSUE[region]), rgb(color), OPACITY[lvl ?? 0]);   // null = not characterized
  const levelName = (lvl) => (lvl === null || lvl === undefined ? AP.t('dist.levelUnknown') : LEVEL[lvl]);

  /* Natural tissue colors, shared with the 3D model */
  const TISSUE = {
    ctx: '#deb0a0', cb: '#d6a595', tha: '#d3a596', str: '#d3a596', hip: '#d8ab9c', amy: '#d3a596',
    hyp: '#d6a99a', ob: '#e0b6a7', bs: '#eedccb', sc: '#efe0d0', pit: '#e9c8b8',
  };


  /* ---------- 2D map: pre-rendered views colored on a canvas ---------- */
  function load2d() {
    const decode = (name, w, h) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
        resolve(g.getImageData(0, 0, w, h).data);
      };
      img.onerror = () => reject(new Error(`could not load ${ModelFiles.url(name)}`));
      img.src = ModelFiles.url(name);
    });
    return ModelFiles.json('brain-2d.json').then(data => Promise.all(Object.entries(data.views).map(([k, v]) =>
      Promise.all([decode(v.png, v.w, v.h), decode(v.behind, v.w, v.h)])
        .then(([pix, behind]) => [k, { w: v.w, h: v.h, anchors: v.anchors, origin: v.origin, pix, behind }])))
      .then(entries => { view2d = Object.fromEntries(entries); view2d.ids = data.regions; view2d.front = data.front; view2d.res = data.res; }))
      .then(() => ModelFiles.json('brain-mesh.json')).then(m => { mniT = m.mniToModel || null; project2d(); });
  }

  let off2d = null; // colored offscreen image of the current view

  function color2d() {
    if (!view2d) return;
    const side = window.Brain3D ? window.Brain3D.translucent : 'L';
    const v = view2d[side];
    const d = DIST[current]; const color = cardColor(current);
    const byId = [];
    Object.entries(view2d.ids).forEach(([key, id]) => { byId[id] = regionColor(key, d[key][0], color); });
    const glass = regionColor('ctx', d.ctx[0], color).map(x => x * 0.85);
    off2d = off2d || document.createElement('canvas');
    off2d.width = v.w; off2d.height = v.h;
    const g = off2d.getContext('2d');
    const out = g.createImageData(v.w, v.h);
    const src = v.pix, under = v.behind, dst = out.data, F = view2d.front;
    const selId = selected ? view2d.ids[selected] : -1;
    const acc = rgb(SELECT_COLOR);
    const base = (k) => (src[k] >= F ? src[k] - F : src[k]);
    const isSel = (k) => src[k + 3] && (base(k) === selId || (selId === 1 && !src[k] && src[k + 2] > 0));
    for (let i = 0; i < src.length; i += 4) {
      if (src[i + 3] === 0) continue;
      const id = base(i), sh = src[i + 1] / 200, ga = src[i + 2] / 255;
      let r = 255, gg = 255, b = 255;
      if (id) { const c = byId[id]; r = c[0] * sh; gg = c[1] * sh; b = c[2] * sh; }
      // Structures in the translucent half are semi-translucent (the selected one stays opaque)
      if (src[i] >= F && id !== selId) {
        let ur = 255, ug = 255, ub = 255;
        if (under[i + 3] && under[i]) { const c = byId[under[i]], us = under[i + 1] / 200; ur = c[0] * us; ug = c[1] * us; ub = c[2] * us; }
        r = r * FRONT_ALPHA + ur * (1 - FRONT_ALPHA); gg = gg * FRONT_ALPHA + ug * (1 - FRONT_ALPHA); b = b * FRONT_ALPHA + ub * (1 - FRONT_ALPHA);
      }
      r = r * (1 - ga) + glass[0] * ga; gg = gg * (1 - ga) + glass[1] * ga; b = b * (1 - ga) + glass[2] * ga;
      let a = id ? 255 : Math.round(255 * Math.min(1, ga * 2.2));
      if (selId > 0 && isSel(i)) {
        // Selected structure: red outline (2 px at image resolution) and a light red wash
        const p = i / 4, x = p % v.w, y = (p - x) / v.w;
        let edge = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= v.w || yy >= v.h || !isSel((yy * v.w + xx) * 4)) { edge = true; break; }
        }
        const t = edge ? 1 : 0.22;
        r += (acc[0] - r) * t; gg += (acc[1] - gg) * t; b += (acc[2] - b) * t;
        if (edge) a = 255;
      }
      dst[i] = r; dst[i + 1] = gg; dst[i + 2] = b; dst[i + 3] = a;
    }
    g.putImageData(out, 0, 0);
    draw2d();
  }

  /** Image -> screen transform for the 2D canvas (fit with margin, then zoom about the center) */
  const LABEL_MIN_WIDTH = 520; // narrower viewers omit the label columns (names on hover/tap)
  function fit2d(cv, v) {
    const pad = 28, padX = cv.clientWidth >= LABEL_MIN_WIDTH ? 110 : 12;
    const s = Math.min((cv.clientWidth - 2 * padX) / v.w, (cv.clientHeight - 2 * pad) / v.h) * zoom2d;
    return { s, x: (cv.clientWidth - v.w * s) / 2, y: (cv.clientHeight - v.h * s) / 2 };
  }

  function draw2d() {
    const cv = document.getElementById('dist-2d');
    if (!cv || mode !== '2d' || !off2d || !view2d) return;
    const side = window.Brain3D ? window.Brain3D.translucent : 'L';
    const v = view2d[side];
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
    const t = fit2d(cv, v);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(off2d, t.x, t.y, v.w * t.s, v.h * t.s);
    drawPaths2d(g, t);
    // Atlas-style labels: two columns beside the brain, ordered by height, with leader lines
    if (cv.clientWidth < LABEL_MIN_WIDTH) return;
    const f = AP.plotFont();
    g.font = `500 ${f.size}px ${f.family}`;
    g.textBaseline = 'middle';
    const W = cv.clientWidth, bx0 = t.x, bx1 = t.x + v.w * t.s;
    const pts = Object.entries(v.anchors).map(([key, [ax, ay]]) => ({ key, px: t.x + ax * t.s, py: t.y + ay * t.s }));
    const cortex = pts.find(p => p.key === 'ctx');
    const cx = (bx0 + bx1) / 2;
    ['left', 'right'].forEach(colSide => {
      const col = pts.filter(p => p.key !== 'ctx' && (colSide === 'left' ? p.px < cx : p.px >= cx)).sort((a, b) => a.py - b.py);
      let last = -Infinity;
      col.forEach(p => { p.ly = Math.max(p.py, last + 20); last = p.ly; });
      const over = last - (cv.clientHeight - 30);
      if (over > 0) col.forEach(p => { p.ly -= over; });
      const lx = colSide === 'left' ? Math.max(8, bx0 - 14) : Math.min(W - 8, bx1 + 14);
      g.textAlign = colSide === 'left' ? 'right' : 'left';
      col.forEach(p => {
        const name = REGIONS[p.key].name;
        const ex = colSide === 'left' ? lx + 4 : lx - 4;
        g.strokeStyle = 'rgba(52,58,64,.5)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(ex, p.ly); g.lineTo(colSide === 'left' ? Math.min(p.px - 6, ex + 18) : Math.max(p.px + 6, ex - 18), p.ly); g.lineTo(p.px, p.py); g.stroke();
        g.fillStyle = '#343a40'; g.beginPath(); g.arc(p.px, p.py, 2.2, 0, Math.PI * 2); g.fill();
        g.lineWidth = 3.5; g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineJoin = 'round';
        const sel = p.key === selected;
        g.font = `${sel ? 600 : 500} ${f.size}px ${f.family}`;
        g.strokeText(name, lx, p.ly); g.fillStyle = sel ? SELECT_COLOR : '#212529'; g.fillText(name, lx, p.ly);
      });
    });
    if (cortex) {
      g.textAlign = 'center';
      g.lineWidth = 3.5; g.strokeStyle = 'rgba(255,255,255,.9)';
      g.strokeText(REGIONS.ctx.name, cortex.px, Math.max(10, cortex.py - 10));
      g.fillStyle = '#212529'; g.fillText(REGIONS.ctx.name, cortex.px, Math.max(10, cortex.py - 10));
    }
  }

  function pick2d(ev) {
    const cv = document.getElementById('dist-2d');
    if (!view2d || !cv) return null;
    const v = view2d[window.Brain3D ? window.Brain3D.translucent : 'L'];
    const r = cv.getBoundingClientRect();
    const t = fit2d(cv, v);
    const x = Math.floor((ev.clientX - r.left - t.x) / t.s), y = Math.floor((ev.clientY - r.top - t.y) / t.s);
    if (x < 0 || y < 0 || x >= v.w || y >= v.h) return null;
    const i = (y * v.w + x) * 4;
    if (!v.pix[i + 3]) return null;
    const id = v.pix[i] >= view2d.front ? v.pix[i] - view2d.front : v.pix[i];
    if (!id) return 'ctx'; // translucent hemisphere only
    return Object.keys(view2d.ids).find(k => view2d.ids[k] === id) || null;
  }

  /* ---------- Stage (same layout and controls as the receptor viewer) ---------- */
  function init() {
    const host = document.getElementById('dist-panel');
    if (!host) return;
    readRegions();
    host.innerHTML = `
      <div class="dist-grid">
        <div class="illo-stage dist-stage">
          <div class="rx-title" id="dist-stage-title"></div>
          <div class="mol-wrap">
            <div class="mol-viewer brain-viewer" id="dist-viewer">
              <div id="dist-3d" class="brain-layer"></div>
              <canvas id="dist-2d" class="brain-layer" hidden></canvas>
              <div class="mol-loading">${AP.t('dist.loading')}</div>
              <div class="brain3d-tip"></div>
            </div>
            <p class="mol-hint" id="dist-hint">${AP.t('dist.hint3d')}</p>
          </div>
          <div class="rx-badge" id="dist-badge"></div>
          <label class="mol-zoom">${AP.t('dist.zoom')}
            <input type="range" id="dist-zoom" min="-1" max="2" step="0.05" value="0" aria-label="${AP.t('dist.zoomLevel')}" />
            <b id="dist-zoom-val">1.0×</b>
          </label>
          <div class="mol-toolbar">
            <button type="button" data-act="reset" title="${AP.t('dist.resetTip')}">${AP.t('dist.reset')}</button>
            <button type="button" data-act="top" title="${AP.t('dist.topTip')}">${AP.t('dist.top')}</button>
            <button type="button" data-act="front" title="${AP.t('dist.frontTip')}">${AP.t('dist.front')}</button>
            <button type="button" data-act="hemi" id="dist-btn-hemi"></button>
            <button type="button" data-act="mode" id="dist-btn-mode"></button>
            <button type="button" data-act="paths" id="dist-btn-paths"></button>
          </div>
          <div class="mol-toolbar dist-path-bar">${PATH_ORDER.filter(k => AP.pathways[k]).map(k => `
            <button type="button" data-path-key="${k}" style="--chip:${PATH_COLORS[k]}" title="${AP.t('dist.pathwayTip', { pathway: AP.pathways[k].label })}"><i class="dot"></i>${AP.pathways[k].label}</button>`).join('')}</div>
          <div class="legend" id="dist-legend"></div>
          <div class="dist-paths">
            <div id="dist-path-info" class="dist-path-info"></div>
          </div>
        </div>
        <div class="dist-side">
          <div class="dist-pills">${ORDER.map(k => `
            <button type="button" class="route-drug-chip" data-sub-key="${k}" style="--chip:${cardColor(k)}"
              title="${AP.t('dist.showTarget', { target: AP.targets[k].label })}">${AP.targets[k].label}</button>`).join('')}</div>
          <div id="dist-title" class="dist-title"></div>
          <ul id="dist-list" class="dist-list"></ul>
          <div id="dist-fx" class="dist-fx-panel"></div>
        </div>
      </div>`;

    host.querySelectorAll('.dist-pills button').forEach(b => b.addEventListener('click', () => {
      const k = b.getAttribute('data-sub-key');
      if (window.syncTargetSelection) window.syncTargetSelection(k, 'dist');
      else update(k);
    }));
    host.querySelectorAll('.dist-path-bar button').forEach(b => b.addEventListener('click', () => {
      const k = b.getAttribute('data-path-key');
      choosePath(paths.selected === k ? null : k);
    }));
    host.querySelector('.mol-toolbar').addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b || b.disabled) return;
      const act = b.getAttribute('data-act');
      if (act === 'mode') return setMode(mode === '3d' ? '2d' : '3d');
      if (act === 'paths') { paths.on = !paths.on; pushPaths(); refreshToolbar(); return; }
      if (act === 'hemi') {
        const next = window.Brain3D.translucent === 'L' ? 'R' : 'L';
        window.Brain3D.setTranslucent(next);
        project2d(); color2d(); refreshToolbar(); return;
      }
      if (act === 'reset') { setZoom(1); if (has3d) window.Brain3D.resetView(); return; }
      if (has3d) window.Brain3D.view(act);
    });
    const zr = host.querySelector('#dist-zoom');
    zr.addEventListener('input', () => setZoom(Math.pow(2, parseFloat(zr.value))));

    const viewer = host.querySelector('#dist-viewer');
    const tip = viewer.querySelector('.brain3d-tip');
    viewer.addEventListener('pointermove', ev => {
      const pw = pickPath(ev);
      const region = pw ? null : (mode === '3d' ? (has3d ? window.Brain3D.pick(ev) : null) : pick2d(ev));
      if (!region && !pw) { tip.style.display = 'none'; return; }
      if (pw) {
        const p = AP.pathways[pw.key];
        tip.innerHTML = `<b style="color:${PATH_COLORS[pw.key]}">${AP.t('rx.info.pathwayTitle', { pathway: p.label })}</b><br>${AP.t('dist.pathwayCourse', { origin: p.geometry.origin, targets: p.geometry.targets })}`;
      } else {
        const [lvl, note] = DIST[current][region];
        tip.innerHTML = `<b>${REGIONS[region].name}</b><br>${AP.targets[current].label}: ${levelName(lvl).toLowerCase()}${note ? `<br><span>${note}</span>` : ''}`;
      }
      const r = viewer.getBoundingClientRect();
      tip.style.display = 'block';
      tip.style.left = `${Math.min(ev.clientX - r.left + 14, r.width - 250)}px`;
      tip.style.top = `${ev.clientY - r.top + 10}px`;
    });
    viewer.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
    // Click (not drag) on a structure selects it; clicking it again or empty space clears
    let down = null;
    viewer.addEventListener('pointerdown', ev => { down = [ev.clientX, ev.clientY]; });
    viewer.addEventListener('pointerup', ev => {
      if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 5) { down = null; return; }
      down = null;
      const pw = pickPath(ev);
      if (pw) { choosePath(paths.selected === pw.key ? null : pw.key); return; }
      const region = mode === '3d' ? (has3d ? window.Brain3D.pick(ev) : null) : pick2d(ev);
      select(region && region !== selected ? region : null);
    });
    host.querySelector('#dist-list').addEventListener('click', ev => {
      const li = ev.target.closest('li[data-region]'); if (!li) return;
      const r = li.getAttribute('data-region');
      select(r === selected ? null : r);
    });
    host.querySelector('#dist-2d').addEventListener('wheel', ev => {
      ev.preventDefault();
      setZoom(Math.min(4, Math.max(0.5, zoom2d * Math.pow(1.0015, -ev.deltaY))));
    }, { passive: false });
    new ResizeObserver(() => draw2d()).observe(viewer);

    const twoD = load2d().catch(err => console.warn('[distribution] 2D map unavailable:', err));
    const threeD = window.Brain3D ? window.Brain3D.init(host.querySelector('#dist-3d')) : Promise.resolve(false);
    if (window.Brain3D) window.Brain3D.onZoom(level => syncZoom(level));
    Promise.all([threeD, twoD]).then(([ok]) => {
      has3d = !!ok;
      const loading = viewer.querySelector('.mol-loading');
      if (!has3d && !view2d) {
        // Neither view could load (e.g. page opened from disk): say why instead of an empty stage
        if (loading) loading.textContent = AP.t('dist.unavailable', { reason: (window.Brain3D && window.Brain3D.lastError) || AP.t('dist.filesMissing') });
      } else if (loading) loading.remove();
      setMode(has3d ? '3d' : '2d');
      update(current);
      pushPaths();
    });
    refreshToolbar();
    update(current);
    renderPathInfo();
  }

  /* ---------- Dopaminergic pathways ---------- */
  const pathItems = () => PATH_ORDER.map(k => [k, AP.pathways[k]]).filter(([, p]) => p && p.geometry).map(([key, p]) => ({
    key, color: PATH_COLORS[key], lines: p.geometry.mni, endpoint: p.geometry.endpoint || null,
  }));

  /** Send the overlay to the 3D model and redraw the 2D map */
  function pushPaths() {
    if (window.Brain3D) window.Brain3D.setPathways({ on: paths.on, selected: paths.selected, items: pathItems() });
    project2d();
    draw2d();
    renderPathInfo();
    refreshLegend();
  }

  /** Selected pathway from the map or chips; mirrored in the mechanism section */
  function choosePath(key) {
    if (window.syncPathwaySelection && key) window.syncPathwaySelection(key, 'dist');
    else setPathway(key);
  }

  /** Called by the pathway synchronizer (main.js) */
  function setPathway(key) {
    paths.selected = key && AP.pathways[key] ? key : null;
    if (paths.selected) paths.on = true;
    document.querySelectorAll('.dist-path-bar button').forEach(b => b.classList.toggle('active', b.getAttribute('data-path-key') === paths.selected));
    pushPaths();
    refreshToolbar();
  }

  function renderPathInfo() {
    const box = document.getElementById('dist-path-info');
    if (!box) return;
    // Every text is laid out in the same grid cell and only the selected one is visible,
    // so the box always has the height of the longest text and the frame does not jump
    const text = (k) => {
      const p = AP.pathways[k];
      return `<b style="color:${PATH_COLORS[k]}">${p.label}</b> · ${AP.t('dist.pathwayCourse', { origin: p.geometry.origin, targets: p.geometry.targets })}. ${p.role}`;
    };
    box.innerHTML = PATH_ORDER.filter(k => AP.pathways[k]).map(k => `<div class="${k === paths.selected ? 'on' : ''}">${text(k)}</div>`).join('')
      + `<div class="muted${paths.selected ? '' : ' on'}">${AP.t('dist.pathwayHint')}</div>`;
  }

  /** MNI point -> image pixel of the current lateral view */
  function mniToPx(pt, v) {
    const sc = mniT.scale, sh = mniT.shift, side = (window.Brain3D ? window.Brain3D.translucent : 'L') === 'L' ? -1 : 1;
    const y = pt[1] * sc[1] + sh[1], z = pt[2] * sc[2] + sh[2];
    return [((side < 0 ? -y : y) - v.origin[0]) / view2d.res, (-z - v.origin[1]) / view2d.res];
  }

  /** Uniform Catmull-Rom sampling of a 2D polyline */
  function smooth(pts, n = 10) {
    if (pts.length < 3) return pts;
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let k = 0; k < n; k++) {
        const t = k / n, t2 = t * t, t3 = t2 * t;
        out.push([0, 1].map(j => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function project2d() {
    path2d = [];
    if (!view2d || !mniT) return;
    const v = view2d[window.Brain3D ? window.Brain3D.translucent : 'L'];
    if (!v || !v.origin) return;
    pathItems().forEach(it => {
      it.lines.forEach(line => path2d.push({ key: it.key, pts: smooth(line.map(pt => mniToPx(pt, v))) }));
    });
  }

  function drawPaths2d(g, t) {
    if (!paths.on || !path2d.length) return;
    const S = (p) => [t.x + p[0] * t.s, t.y + p[1] * t.s];
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    path2d.forEach(pl => {
      const sel = !paths.selected || paths.selected === pl.key;
      g.globalAlpha = sel ? 1 : 0.35;
      const col = PATH_COLORS[pl.key], w = paths.selected === pl.key ? 4 : 3;
      const pts = pl.pts.map(S);
      const stroke = (width, colr) => { g.strokeStyle = colr; g.lineWidth = width; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); };
      stroke(w + 3, 'rgba(255,255,255,.85)');
      stroke(w, col);
      // arrowhead with its tip exactly at the target point
      const [x2, y2] = pts[pts.length - 1], [x1, y1] = pts[Math.max(0, pts.length - 4)];
      const a = Math.atan2(y2 - y1, x2 - x1), L = 5 + w * 2;
      g.fillStyle = col; g.beginPath();
      g.moveTo(x2, y2);
      g.lineTo(x2 + Math.cos(a + 2.6) * L, y2 + Math.sin(a + 2.6) * L);
      g.lineTo(x2 + Math.cos(a - 2.6) * L, y2 + Math.sin(a - 2.6) * L);
      g.closePath(); g.fill();
    });
    g.restore();
  }

  /** Pathway under the pointer in the current mode, or null */
  function pickPath(ev) {
    if (!paths.on) return null;
    if (mode === '3d') return has3d ? window.Brain3D.pickPathway(ev) : null;
    const cv = document.getElementById('dist-2d');
    if (!cv || !view2d || !path2d.length) return null;
    const v = view2d[window.Brain3D ? window.Brain3D.translucent : 'L'];
    const t = fit2d(cv, v), r = cv.getBoundingClientRect();
    const mx = ev.clientX - r.left, my = ev.clientY - r.top;
    let best = null, bestD = 7;
    path2d.forEach(pl => {
      for (let i = 1; i < pl.pts.length; i++) {
        const [ax, ay] = [t.x + pl.pts[i - 1][0] * t.s, t.y + pl.pts[i - 1][1] * t.s], [bx, by] = [t.x + pl.pts[i][0] * t.s, t.y + pl.pts[i][1] * t.s];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / l2));
        const d = Math.hypot(ax + u * dx - mx, ay + u * dy - my);
        if (d < bestD) { bestD = d; best = { key: pl.key }; }
      }
    });
    return best;
  }

  /** Legend: abundance levels of the target (the pathway colors are on the pathway buttons) */
  function refreshLegend() {
    const legend = document.getElementById('dist-legend');
    if (!legend || !DIST[current]) return;
    const color = cardColor(current);
    legend.innerHTML = `<div class="legend-row">${LEVEL.map((l, i) => `<span><i class="dot" style="background:${css(regionColor('ctx', i, color))}"></i>${l}</span>`).join('')}</div>`;
  }

  /** Selection shared by the list, the 3D model and the 2D map */
  function select(region) {
    selected = region;
    document.querySelectorAll('#dist-list li[data-region]').forEach(li =>
      li.classList.toggle('selected', li.getAttribute('data-region') === region));
    if (window.Brain3D) window.Brain3D.setSelected(region, SELECT_COLOR);
    color2d();
    renderEffects();
  }

  /** Effects of activating and blocking the shown receptor in the selected region, below the region list */
  function renderEffects() {
    const box = document.getElementById('dist-fx');
    if (!box || !DIST[current]) return;
    const t = AP.targets[current];
    if (!selected) { box.innerHTML = `<span class="muted">${AP.t('dist.effectsHint', { target: t.label })}</span>`; return; }
    const [lvl, , act, block, path] = DIST[current][selected];
    const row = (label, txt) => `<div><span class="dist-fx-label">${label}</span>${txt || '<span class="muted">-</span>'}</div>`;
    box.innerHTML = (lvl ? row(AP.t('dist.activation'), act) + row(AP.t('dist.blockade'), block) + (path ? row(AP.t('dist.pathwayEffect'), path) : '') : `<div class="muted">${AP.t(lvl === null ? 'dist.effectUnknown' : 'dist.effectAbsent')}</div>`);
  }

  function setMode(m) {
    mode = m;
    const c3 = document.getElementById('dist-3d'), c2 = document.getElementById('dist-2d');
    if (!c3 || !c2) return;
    c3.hidden = m !== '3d'; c2.hidden = m !== '2d';
    if (window.Brain3D) window.Brain3D.setActive(m === '3d');
    setZoom(1);
    color2d();
    refreshToolbar();
  }

  function setZoom(level) {
    if (mode === '3d' && has3d) window.Brain3D.setZoom(level);
    else { zoom2d = level; draw2d(); }
    syncZoom(level);
  }

  function syncZoom(level) {
    const zr = document.getElementById('dist-zoom'), zv = document.getElementById('dist-zoom-val');
    if (zr) zr.value = Math.log2(level).toFixed(2);
    if (zv) zv.textContent = `${AP.fmt(level, 1)}×`;
  }

  function refreshToolbar() {
    const hemi = window.Brain3D ? window.Brain3D.translucent : 'L';
    const bh = document.getElementById('dist-btn-hemi'), bm = document.getElementById('dist-btn-mode');
    if (!bh || !bm) return;
    bh.textContent = AP.t(hemi === 'L' ? 'dist.rightTransl' : 'dist.leftTransl');
    bh.title = AP.t(hemi === 'L' ? 'dist.rightTranslTip' : 'dist.leftTranslTip');
    bm.textContent = AP.t(mode === '3d' ? 'dist.map2d' : 'dist.model3d');
    bm.title = AP.t(mode === '3d' ? 'dist.to2dTip' : 'dist.to3dTip');
    bm.disabled = mode === '2d' && !has3d;
    const bp = document.getElementById('dist-btn-paths');
    if (bp) {
      bp.textContent = AP.t(paths.on ? 'dist.pathwaysHide' : 'dist.pathwaysShow');
      bp.title = AP.t('dist.pathwaysTip');
      bp.classList.toggle('on', paths.on);
    }
    if (bm.disabled) bm.title = `${AP.t('dist.no3d')}${window.Brain3D && window.Brain3D.lastError ? ` (${window.Brain3D.lastError})` : ''}`;
    document.querySelectorAll('#dist-panel .mol-toolbar [data-act="top"], #dist-panel .mol-toolbar [data-act="front"]').forEach(b => {
      b.disabled = mode !== '3d';
    });
    const hint = document.getElementById('dist-hint');
    if (hint) hint.textContent = mode === '3d'
      ? AP.t('dist.hint3d')
      : AP.t('dist.hint2d');
  }

  function update(subKey) {
    const host = document.getElementById('dist-panel');
    if (!host || !DIST[subKey]) return;
    const s = AP.targets[subKey];
    const color = cardColor(subKey);
    const d = DIST[subKey];
    current = subKey;

    if (window.Brain3D) {
      const lv = {};
      Object.keys(REGIONS).forEach(id => { lv[id] = OPACITY[d[id][0] ?? 0]; });
      window.Brain3D.setLevels(lv, color);
    }
    color2d();

    host.querySelectorAll('.dist-pills button').forEach(b => b.classList.toggle('active', b.getAttribute('data-sub-key') === subKey));
    const title = document.getElementById('dist-stage-title');
    if (title) title.textContent = AP.t('dist.stageTitle', { label: s.label });
    const badge = document.getElementById('dist-badge');
    if (badge) { badge.textContent = `${s.label} · ${s.family.toLowerCase()}`; badge.style.background = color; }
    refreshLegend();

    // second line: signaling, endogenous ligand and the three drugs with the lowest Kᵢ (INNs lower case mid-sentence)
    const top = Object.values(AP.drugs).filter(d => d.pd.ki[subKey] < AP.NB).sort((a, b) => a.pd.ki[subKey] - b.pd.ki[subKey]).slice(0, 3)
      .map(d => `${d.name.toLowerCase()} ${AP.fmtAuto(d.pd.ki[subKey])} nM`).join(', ');
    document.getElementById('dist-title').innerHTML = `<b style="color:${color}">${s.label}</b> · ${AP.t('dist.familyReceptor', { family: s.family })} · ${s.location}`
      + `<div class="dist-subtitle">${s.signaling ? `${s.signaling}. ` : ''}${AP.t('dist.endogenous', { ligand: s.endogenous })}. ${top ? `${AP.t('dist.topBinders', { list: top })}.` : ''}</div>`;
    const rows = Object.keys(REGIONS).map(id => ({ id, lvl: d[id][0], note: d[id][1], act: d[id][2], block: d[id][3] }))
      .sort((a, b) => (b.lvl ?? -1) - (a.lvl ?? -1));
    document.getElementById('dist-list').innerHTML = rows.map(r => `
      <li class="${r.lvl ? '' : 'absent'}${r.id === selected ? ' selected' : ''}" data-region="${r.id}" title="${AP.t('dist.selectRegion', { region: REGIONS[r.id].name })}">
        <i class="dist-swatch" style="background:${css(regionColor(r.id, r.lvl, color))}" title="${AP.t('dist.swatchTip')}"></i>
        <b>${REGIONS[r.id].name}</b>
        <span class="dist-level">${levelName(r.lvl)}</span>${r.note ? `<span class="dist-note">${r.note}</span>` : ''}
      </li>`).join('');
    renderEffects();
  }

  return { init, update, setPathway };
})();
