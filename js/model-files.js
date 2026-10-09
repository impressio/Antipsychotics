/* =====================================================================
 * model-files.js - loads model data from assets/models/
 *
 * The app is served over http(s) (GitHub Pages, or `python3 -m http.server`
 * locally); browsers block fetch() of local files when index.html is opened
 * directly from disk, in which case the loaders reject with a clear message.
 * Files ending in .gz are decompressed with the browser's DecompressionStream
 * unless the server already decoded them (detected by the gzip magic bytes).
 * ===================================================================== */
window.ModelFiles = (function () {
  'use strict';

  const DIR = 'assets/models/';
  const url = (name) => DIR + name;

  async function get(name) {
    if (location.protocol === 'file:') {
      throw new Error('model files need a web server: run "python3 -m http.server" in the project folder and open http://localhost:8000');
    }
    const res = await fetch(url(name));
    if (!res.ok) throw new Error(`could not load ${url(name)} (HTTP ${res.status})`);
    return res;
  }

  /** ArrayBuffer of a model file; gzip is undone if still present */
  async function buffer(name) {
    const buf = await (await get(name)).arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    if (head[0] !== 0x1f || head[1] !== 0x8b) return buf;
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }

  const text = async (name) => new TextDecoder().decode(await buffer(name));
  const json = async (name) => (await get(name)).json();

  return { url, buffer, text, json };
})();
