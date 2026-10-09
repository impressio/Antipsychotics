/* =====================================================================
 * tex.js - LaTeX equations rendered with KaTeX
 *
 * Markup: <span class="tex" data-tex="LaTeX">plain-text fallback</span>
 * (add class "tex-display" for a displayed equation). Equations added
 * later by other modules are rendered automatically; if KaTeX is not
 * available (e.g. offline), the plain-text fallback remains.
 * ===================================================================== */
(function () {
  'use strict';

  function render(root) {
    if (!window.katex || !root || !root.querySelectorAll) return;
    const sel = '.tex[data-tex]:not(.tex-done)';
    const els = [...(root.matches && root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)];
    els.forEach(el => {
      try {
        window.katex.render(el.getAttribute('data-tex'), el, {
          displayMode: el.classList.contains('tex-display'), throwOnError: false, output: 'htmlAndMathml',
        });
        el.classList.add('tex-done');
      } catch (e) { /* keep the fallback text */ }
    });
  }

  window.renderTex = render;
  const start = () => {
    render(document.body);
    new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(n => {
      if (n.nodeType === 1 && n.isConnected) render(n);
    }))).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
