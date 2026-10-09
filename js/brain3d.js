/* =====================================================================
 * brain3d.js - Rotatable 3D brain for the regional distribution map
 *
 * Meshes (assets/models/brain-mesh.bin.gz + .json, built by tools/build_brain.py from TemplateFlow):
 * fsaverage6 pial surfaces (left and right cortex, shaded by sulcal depth)
 * and smoothed surfaces of the aseg segmentation of the MNI152 2009c
 * template (thalamus, striatum, hippocampus, amygdala, brainstem,
 * cerebellum), plus approximated hypothalamus, olfactory bulbs and spinal
 * cord. One hemisphere is rendered translucent to expose deep structures.
 * Optional overlay: dopaminergic pathways drawn as tubes along their course
 * (MNI coordinates from properties.json, placed with the build's MNI-to-model
 * transform in brain-mesh.json), with pulses traveling from origin to target.
 * Requires three.js (import map in index.html); init() resolves false if
 * WebGL or the assets are unavailable so the caller can fall back.
 * ===================================================================== */
window.Brain3D = (function () {
  'use strict';

  /* Natural tissue colors (fresh brain): gray matter pinkish beige, deep nuclei
   * slightly darker, brainstem and spinal cord (largely white matter) cream */
  const TISSUE = {
    ctx: '#deb0a0', cb: '#d6a595', tha: '#d3a596', str: '#d3a596', hip: '#d8ab9c', amy: '#d3a596',
    hyp: '#d6a99a', ob: '#e0b6a7', bs: '#eedccb', sc: '#efe0d0', pit: '#e9c8b8',
  };

  let THREE, renderer, scene, camera, controls, host;
  let active = true, zoomCb = null, homeDist = 1;
  const parts = []; // { mesh, region, hemi, name }
  let translucent = 'L';
  let state = { color: '#5b8def', levels: {} };
  let selection = { region: null, color: '#0d99ff' };
  let dirty = true;
  let mniT = null;               // { scale, shift }: MNI152 mm -> model mm (brain-mesh.json mniToModel)
  let pathGroup = null;          // overlay of dopaminergic pathways
  let pathSpec = null;           // last spec passed to setPathways
  let pulses = [];               // { mesh, curve, phase, speed }
  let visible = true;            // viewer on screen (pulses animate only then)
  const HOME = { pos: [-400, 70, -110], target: [0, -23, 0] }; // target chosen so the brain sits vertically centered in the viewer

  let lastError = '';

  /* Decoders for assets/models/brain-mesh.bin.gz (see tools/build_brain.py): each array is stored
   * delta-coded as byte planes (all first bytes, then all second bytes, ...) */
  function bytePlanes(bytes, off, n, size) {
    const out = new Uint32Array(n);
    for (let k = 0; k < size; k++) {
      const plane = bytes.subarray(off + k * n, off + (k + 1) * n), shift = 8 * k;
      for (let i = 0; i < n; i++) out[i] |= plane[i] << shift;
    }
    return out;
  }
  /** int16 positions, delta-coded per axis (x, y, z interleaved) */
  function decodePositions(bytes, off, nv) {
    const d = bytePlanes(bytes, off, nv * 3, 2), out = new Int16Array(nv * 3);
    for (let i = 0; i < nv * 3; i++) out[i] = (i < 3 ? 0 : out[i - 3]) + d[i]; // Int16Array wraps like the encoder
    return out;
  }
  /** triangle indices, zigzag delta-coded uint32 */
  function decodeIndices(bytes, off, n) {
    const z = bytePlanes(bytes, off, n, 4), out = new Uint32Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) { prev += (z[i] >>> 1) ^ -(z[i] & 1); out[i] = prev; }
    return out;
  }
  /** uint8 sulcal depth, delta-coded with wrap-around */
  function decodeSulc(bytes, off, nv) {
    const out = new Uint8Array(nv);
    for (let i = 0; i < nv; i++) out[i] = (i ? out[i - 1] : 0) + bytes[off + i]; // Uint8Array wraps
    return out;
  }

  async function init(container) {
    host = container;
    try {
      // three.js r163+ requires WebGL 2: check before downloading the library and the model files
      if (!document.createElement('canvas').getContext('webgl2')) throw new Error('WebGL 2 is not available in this browser');
      THREE = await import('three');
      const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
      const [manifest, bin] = await Promise.all([ModelFiles.json('brain-mesh.json'), ModelFiles.buffer('brain-mesh.bin.gz')]);

      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.95;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      host.appendChild(renderer.domElement);

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(28, 1, 10, 3000);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 160;
      controls.maxDistance = 900;
      controls.addEventListener('change', () => {
        dirty = true;
        if (zoomCb) zoomCb(homeDist / camera.position.distanceTo(controls.target));
      });

      scene.add(new THREE.HemisphereLight(0xffffff, 0x6e524b, 0.75));
      const key = new THREE.DirectionalLight(0xfff4ec, 3.0); key.position.set(-1, 1.4, 1.2);
      const fill = new THREE.DirectionalLight(0xe8eeff, 0.8); fill.position.set(1.2, 0.3, 0.6);
      const rim = new THREE.DirectionalLight(0xffffff, 1.1); rim.position.set(0.2, 0.8, -1.5);
      // Lights follow the camera so the brain stays lit from the viewer's upper left
      const rig = new THREE.Group(); rig.add(key, fill, rim); camera.add(rig); scene.add(camera);

      mniT = manifest.mniToModel || null;
      buildMeshes(manifest, bin);
      if (pathSpec) buildPathways();
      new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); dirty = true; }).observe(host);
      new ResizeObserver(resize).observe(host);
      resize();
      resetView();
      loop();
      return true;
    } catch (err) {
      console.warn('[brain3d] 3D view unavailable, using the 2D map:', err);
      lastError = err && err.message ? err.message : String(err);
      if (renderer) renderer.domElement.remove();
      return false;
    }
  }

  function buildMeshes(manifest, bin) {
    const bytes = new Uint8Array(bin);
    manifest.meshes.forEach(e => {
      const p16 = decodePositions(bytes, e.pos, e.nv);
      const pos = new Float32Array(e.nv * 3);
      // fsaverage RAS (x right, y anterior, z superior) -> three.js (x, z, -y), in mm
      for (let i = 0; i < e.nv; i++) {
        pos[i * 3] = p16[i * 3] / 100;
        pos[i * 3 + 1] = p16[i * 3 + 2] / 100;
        pos[i * 3 + 2] = -p16[i * 3 + 1] / 100;
      }
      const i32 = decodeIndices(bytes, e.idx, e.nf * 3);
      const idx = e.nv < 65536 ? Uint16Array.from(i32) : i32;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeVertexNormals();

      let mat;
      if (e.region === 'ctx') {
        const sulc = decodeSulc(bytes, e.sulc, e.nv);
        // Sulcal fundi darker, gyral crowns lighter (as in surface-based neuroimaging displays)
        const shade = new Float32Array(e.nv);
        for (let i = 0; i < e.nv; i++) shade[i] = 1.12 - 0.55 * Math.pow(sulc[i] / 255, 1.2);
        g.userData.shade = shade;
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(e.nv * 3), 3));
        mat = new THREE.MeshPhysicalMaterial({
          vertexColors: true, roughness: 0.52, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.45,
          sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color('#ffd9cc'),
        });
      } else {
        mat = new THREE.MeshPhysicalMaterial({ roughness: 0.5, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.5 });
        if (e.region === 'cb') addFolia(mat, g);
      }
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData = { region: e.region, hemi: e.hemi, name: e.name };
      scene.add(mesh);
      parts.push(mesh);
    });
    applyTranslucency();
  }

  /** Cerebellar folia: curved transverse grooves from concentric shells around the peduncles */
  function addFolia(mat, g) {
    g.computeBoundingBox();
    const bb = g.boundingBox;
    const c = new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.max.y + 6, (bb.min.z + bb.max.z) / 2 - 10);
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uFoliaC = { value: c };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;\nuniform vec3 uFoliaC;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float foliaPh = length(vObjPos - uFoliaC) * 2.3 + 0.8 * sin(vObjPos.x * 0.21);
          diffuseColor.rgb *= 0.9 + 0.1 * smoothstep(-0.6, 0.9, sin(foliaPh));`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          vec3 foliaG = normalize((viewMatrix * vec4(normalize(vObjPos - uFoliaC), 0.0)).xyz);
          normal = normalize(normal + 0.2 * cos(foliaPh) * foliaG);`);
    };
  }

  /** Translucent hemisphere: fresnel-weighted alpha so the outline and gyri stay legible */
  function glassify(mat) {
    mat.transparent = true;
    mat.opacity = 0.2;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        float fres = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.2);
        gl_FragColor.a *= mix(0.3, 2.6, fres);`);
    };
    mat.needsUpdate = true;
  }

  /** Structures in the translucent half (deep nuclei, half-cerebellum, olfactory bulb) are
   * semi-translucent so the medial surface behind them shows; midline structures stay opaque */
  const FRONT_ALPHA = 0.72; // higher than in 2D: the translucent hemisphere also lies over them here
  function applyFrontAlpha() {
    parts.filter(m => m.userData.region !== 'ctx').forEach(m => {
      const front = m.userData.hemi === translucent && m.userData.region !== selection.region;
      if (m.material.transparent !== front) m.material.needsUpdate = true;
      m.material.transparent = front;
      m.material.opacity = front ? FRONT_ALPHA : 1;
      m.material.depthWrite = !front;
      m.renderOrder = front ? 1 : 0;
    });
  }

  function applyTranslucency() {
    applyFrontAlpha();
    parts.filter(m => m.userData.region === 'ctx').forEach(m => {
      const glass = m.userData.hemi === translucent;
      if (glass) glassify(m.material);
      else {
        m.material.transparent = false; m.material.opacity = 1; m.material.depthWrite = true;
        m.material.side = THREE.FrontSide; m.material.onBeforeCompile = () => {}; m.material.needsUpdate = true;
      }
      m.renderOrder = glass ? 2 : 0;
    });
    dirty = true;
  }

  function setTranslucent(hemi) {
    translucent = hemi;
    if (!scene) return;
    applyTranslucency();
    resetView(); // face the translucent side
  }

  /** Camera on the given side (-1 left, 1 right), pulled back on narrow viewers so the brain fits */
  function place(side) {
    const fit = Math.max(1, 0.95 / (camera.aspect || 1.3)); // narrow viewers: brain spans ~90% of the width
    camera.position.set(side * Math.abs(HOME.pos[0]) * fit, HOME.pos[1] * fit, HOME.pos[2] * fit);
    controls.target.set(...HOME.target);
    homeDist = camera.position.distanceTo(controls.target);
    controls.update();
    dirty = true;
  }

  /** Preset views: 'top' (from above, frontal pole up) or 'front' (from the frontal pole) */
  function view(which) {
    if (!scene) return;
    const d = camera.position.distanceTo(controls.target);
    const t = controls.target;
    if (which === 'top') camera.position.set(t.x, t.y + d, t.z + 0.01);
    else if (which === 'front') camera.position.set(t.x, t.y + d * 0.12, t.z - d);
    camera.up.set(0, 1, 0);
    controls.update();
    dirty = true;
  }

  /** Zoom level relative to the default view distance (1 = default) */
  function setZoom(level) {
    if (!scene) return;
    const dir = camera.position.clone().sub(controls.target).normalize();
    const dist = Math.min(controls.maxDistance, Math.max(controls.minDistance, homeDist / level));
    camera.position.copy(controls.target).addScaledVector(dir, dist);
    controls.update();
    dirty = true;
  }

  /** Pause rendering while the 2D map is shown */
  function setActive(on) { active = on; dirty = true; }

  function resetView() { place(translucent === 'L' ? -1 : 1); }

  /** Highlight the selected structure (both sides) with an accent-colored glow; null clears */
  function setSelected(region, color) {
    selection = { region, color: color || '#0d99ff' };
    if (!scene) return;
    applyFrontAlpha();
    applyColors();
  }

  /** levels: { region: 0..1 tint weight }, color: CSS color of the isoform */
  function setLevels(levels, color) {
    state = { levels, color };
    if (!scene) return;
    applyColors();
  }

  /** Tissue tinted by abundance; the selected structure is drawn in the selection color (red) with a soft glow */
  function applyColors() {
    const { levels, color } = state;
    const tint = new THREE.Color(color);
    const acc = new THREE.Color(selection.color);
    parts.forEach(m => {
      const r = m.userData.region;
      const on = selection.region && r === selection.region;
      const col = new THREE.Color(TISSUE[r] || '#ddb').lerp(tint, levels[r] || 0);
      if (on) col.lerp(acc, 0.92);
      m.material.emissive.copy(on ? acc : new THREE.Color(0x000000));
      m.material.emissiveIntensity = on ? 0.18 : 0;
      if (r === 'ctx') {
        const shade = m.geometry.userData.shade;
        const arr = m.geometry.attributes.color.array;
        for (let i = 0; i < shade.length; i++) {
          arr[i * 3] = col.r * shade[i]; arr[i * 3 + 1] = col.g * shade[i]; arr[i * 3 + 2] = col.b * shade[i];
        }
        m.geometry.attributes.color.needsUpdate = true;
      } else {
        m.material.color.copy(col);
      }
    });
    dirty = true;
  }

  /** Region under the pointer; the translucent hemisphere is see-through, so report what lies behind it */
  function pick(ev) {
    if (!scene) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(parts, false);
    const behind = hits.find(h => !(h.object.userData.region === 'ctx' && h.object.userData.hemi === translucent));
    const target = behind || hits[0];
    return target ? target.object.userData.region : null;
  }

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }

  function loop(now) {
    requestAnimationFrame(loop);
    if (!active) return;
    if (controls.update()) dirty = true;
    if (pulses.length && visible && !document.hidden) { animatePulses((now ?? performance.now()) / 1000); dirty = true; }
    if (dirty) { renderer.render(scene, camera); dirty = false; }
  }

  /* ---------- Dopaminergic pathways ---------- */

  /** MNI152 point (mm) -> three.js scene point (model RAS: x, z, -y), mirrored to the left for side -1 */
  function mniToScene(p, side) {
    const sc = mniT.scale, sh = mniT.shift;
    const x = side * p[0] * sc[0] + sh[0], y = p[1] * sc[1] + sh[1], z = p[2] * sc[2] + sh[2];
    return new THREE.Vector3(x, z, -y);
  }

  /**
   * spec: { on, selected, items: [{ key, color, lines: [[[x,y,z], ...], ...], endpoint }] }
   * Tubes for each branch on both sides; the selected pathway is drawn stronger and carries pulses
   * (all pathways do when none is selected). Cheap to rebuild: a few dozen small meshes.
   */
  function setPathways(spec) {
    pathSpec = spec;
    if (!scene || !mniT) return;
    buildPathways();
  }

  function buildPathways() {
    if (pathGroup) {
      scene.remove(pathGroup);
      pathGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    pathGroup = new THREE.Group();
    pulses = [];
    const spec = pathSpec;
    if (spec && spec.on) {
      spec.items.forEach(item => {
        const sel = !spec.selected || spec.selected === item.key;
        const col = new THREE.Color(item.color);
        // Drawn in the transparent pass after the translucent tissue (renderOrder 3): visible through the
        // glass hemisphere and the semi-translucent structures, still hidden by opaque tissue in front
        const tubeMat = new THREE.MeshStandardMaterial({
          color: col, emissive: col, emissiveIntensity: sel ? 0.6 : 0.25, roughness: 0.4, metalness: 0,
          transparent: true, opacity: sel ? 1 : 0.4, depthWrite: false,
        });
        [1, -1].forEach(side => {
          item.lines.forEach(line => {
            const curve = new THREE.CatmullRomCurve3(line.map(p => mniToScene(p, side)), false, 'centripetal');
            const r = spec.selected === item.key ? 1.7 : 1.15;
            const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, line.length * 16), r, 10, false), tubeMat);
            tube.renderOrder = 3;
            tube.userData = { pathway: item.key };
            pathGroup.add(tube);
            // arrowhead with its tip exactly at the target point (the cone is centered on its half height)
            const end = curve.getPointAt(1), dir = curve.getTangentAt(1).normalize();
            const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 2.4, r * 6, 12), tubeMat);
            cone.position.copy(end).addScaledVector(dir, -r * 3);
            cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
            cone.userData = { pathway: item.key };
            cone.renderOrder = 3;
            pathGroup.add(cone);
            if (sel) {
              const pulseMat = new THREE.MeshBasicMaterial({ color: col.clone().lerp(new THREE.Color('#ffffff'), 0.6), transparent: true, depthWrite: false });
              const n = Math.max(2, Math.round(curve.getLength() / 22));
              for (let k = 0; k < n; k++) {
                const m = new THREE.Mesh(new THREE.SphereGeometry(r * 1.3, 12, 10), pulseMat);
                m.renderOrder = 4;
                pathGroup.add(m);
                pulses.push({ mesh: m, curve, phase: k / n, speed: 18 / curve.getLength() });   // ≈ 18 mm/s
              }
            }
          });
        });
      });
    }
    scene.add(pathGroup);
    animatePulses(performance.now() / 1000);
    dirty = true;
  }

  function animatePulses(t) {
    pulses.forEach(p => {
      const u = (t * p.speed + p.phase) % 1;
      p.mesh.position.copy(p.curve.getPointAt(u));
      p.mesh.scale.setScalar(Math.min(1, u / 0.08, (1 - u) / 0.08) * 0.8 + 0.2);   // fade in and out at the ends
    });
  }

  /** Pathway under the pointer (tubes, arrowheads), or null */
  function pickPathway(ev) {
    if (!scene || !pathGroup || !pathGroup.children.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pathGroup.children.filter(o => o.userData.pathway), false)[0];
    if (!hit) return null;
    // only if no opaque structure lies in front of it
    const solid = ray.intersectObjects(parts.filter(m => !m.material.transparent), false)[0];
    return solid && solid.distance < hit.distance ? null : { key: hit.object.userData.pathway };
  }

  /** Orbit to a preset side without changing translucency: 'translucent' or 'opaque' */
  function viewSide(which) {
    const t = translucent === 'L' ? -1 : 1;
    place(which === 'opaque' ? -t : t);
  }

  return {
    init, setLevels, setSelected, setTranslucent, resetView, viewSide, view, setZoom, setActive, pick, setPathways, pickPathway,
    onZoom: (cb) => { zoomCb = cb; },
    get translucent() { return translucent; }, get lastError() { return lastError; },
  };
})();
