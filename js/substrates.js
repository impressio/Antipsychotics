/* =====================================================================
 * substrates.js - 2D chemical structures (pre-rendered SVGs in assets/images/structures/,
 * built by tools/build_structures.py with RDKit), biotransformation diagrams,
 * and the interactive substances web table.
 * ===================================================================== */
window.Substrates = (function () {
  'use strict';

  function init() {
    renderLigandGallery();
    renderPathways();
    renderSubstancesTable();
  }

  /** Gallery of 2D molecular structures, one card per drug */
  function renderLigandGallery() {
    const gallery = document.getElementById('ligand-gallery');
    if (!gallery) return;

    // sorted by chemical group (properties.json chemGroups), so similar substances stand next to each other
    const order = (AP.chemGroups || []).map(g => g.key);
    const rank = (d) => { const i = order.indexOf(d.chemGroup); return i < 0 ? order.length : i; };
    const items = Object.entries(AP.drugs).map((e, i) => [e, i]).sort(([a, i], [b, j]) => rank(a[1]) - rank(b[1]) || i - j).map(([e]) => e);
    const card = ([key, item]) => {
      const ki = item.pd.ki.d2, ia = Models.ia(item, 'd2');
      return `
      <div class="card lig-card" data-drug-key="${key}" title="${AP.t('subst.selectAll', { drug: item.name })}">
        <span class="role" style="background:${item.color || '#495057'}; color:#ffffff">${item.role}</span>
        <div class="mol-panel" style="--mol-tint:${item.color || '#5b5bd6'}"><img src="assets/images/structures/${key}.svg" width="200" height="150" alt="${AP.t('subst.structureAlt', { drug: item.name.toLowerCase() })}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'), { className: 'mol-missing', textContent: window.AP.t('subst.structureMissing') }))"></div>
        <h4>${item.name}</h4>
        ${item.mw ? `<p class="muted">${AP.t('subst.mw', { mw: AP.fmt(item.mw, 1) })}</p>` : ''}
        <p>${item.use}</p>
        <p class="muted">${AP.t('subst.d2ki', { ki: ki === undefined ? AP.t('pd.notDetermined') : ki >= AP.NB ? AP.t('subst.noBinding') : `${AP.fmtAuto(ki)} nM` })} · ${ia > 0 ? AP.t('subst.ia', { ia: AP.fmt(ia, 2) }) : ki >= AP.NB ? item.pd.kind.toLowerCase() : AP.t('subst.antagonist')}</p>
      </div>`;
    };
    gallery.innerHTML = items.map(card).join('');

    gallery.querySelectorAll('.lig-card[data-drug-key]').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.getAttribute('data-drug-key');
        if (key && window.syncDrugSelection) window.syncDrugSelection(key, 'gallery');
      });
    });
  }

  /** Biotransformation cascades */
  function renderPathways() {
    const host = document.getElementById('metabolic-pathways');
    if (!host) return;

    host.innerHTML = AP.metabolism.map((pw, pi) => {
      const raw = AP.raw.metabolism[pi];   // English status, for logic
      // Each step's enzyme/reaction describes the conversion leaving that compound
      const arrow = (from) => `
        <div class="pw-arrow">
          <span class="enz ${from.enzClass}">${from.enzyme}</span>
          <div class="line"></div>
          <span>${from.reaction}</span>
        </div>`;
      let inner = '';
      pw.steps.forEach((step, idx) => {
        if (idx > 0) inner += arrow(pw.steps[idx - 1]);
        inner += `
          <div class="pw-node ${raw.steps[idx].status}">
            <b>${step.compound}</b>
            ${step.tHalf ? `<br/><small class="muted">t½ ${/^[~≈]/.test(step.tHalf) ? step.tHalf.replace(/^~/, '≈ ') : '≈ ' + step.tHalf}</small>` : ''}
          </div>`;
      });
      const last = pw.steps.length - 1;
      if (raw.steps[last].status !== 'excreted' && pw.steps[last].enzyme) inner += arrow(pw.steps[last]) + `<div class="pw-node excreted"><b>${AP.t('subst.excretion')}</b></div>`;
      return `
        <div class="card pw-card">
          <h4>${pw.name}</h4>
          <div class="pw-row">${inner}</div>
          <p class="muted">${pw.note}</p>
        </div>`;
    }).join('');
  }

  /* Class codes, matched on the English category in AP.raw (displayed text may be translated) */
  const CLASSES = [
    { code: 'FGA', test: /^FGA/i },
    { code: 'SGA', test: /^SGA/i },
    { code: 'PA', test: /partial agonist/i },
    { code: 'NON-D2', test: /^Non-D2/i },
  ];
  const classOf = (rawCategory) => CLASSES.find(c => c.test.test(rawCategory)) || { code: rawCategory };
  const classKey = (code) => ({ FGA: 'fga', SGA: 'sga', PA: 'pa', 'NON-D2': 'nonD2' }[code]);

  /** Searchable and filterable substances comparison table */
  function renderSubstancesTable() {
    const host = document.getElementById('substances-table-container');
    if (!host) return;
    // rows in the order of the chemical groups (drugs without a group, such as pimavanserin, last)
    const groupOf = (key) => { const g = AP.drugs[key] && AP.drugs[key].chemGroup; const i = (AP.chemGroups || []).findIndex(x => x.key === g); return i < 0 ? 99 : i; };
    const drugOrder = Object.keys(AP.drugs);
    const data = (AP.substancesTable || []).map((d, i) => ({ ...d, code: classOf(AP.raw.substances[i].category).code }))
      .sort((a, b) => groupOf(a.key) - groupOf(b.key) || drugOrder.indexOf(a.key) - drugOrder.indexOf(b.key));

    host.innerHTML = `
      <div class="table-toolbar">
        <div class="search-box">
          <input type="text" id="substances-search" placeholder="${AP.t('subst.searchPlaceholder')}" title="${AP.t('subst.searchTip')}" aria-label="${AP.t('subst.searchLabel')}" />
        </div>
        <div class="filter-pills" id="substances-filters">
          <button type="button" class="pill active" data-filter="all">${AP.t('subst.filterAll', { n: data.length })}</button>
          <button type="button" class="pill" data-filter="FGA" title="${AP.t('subst.cls.fgaName')}">FGA</button>
          <button type="button" class="pill" data-filter="SGA" title="${AP.t('subst.cls.sgaName')}">SGA</button>
          <button type="button" class="pill" data-filter="PA" title="${AP.t('subst.cls.paName')}">PA</button>
          <button type="button" class="pill" data-filter="NON-D2" title="${AP.t('subst.cls.nonD2Name')}">${AP.t('subst.nonD2')}</button>
          <button type="button" class="pill" data-filter="lai" title="${AP.t('subst.laiTip')}">LAI</button>
        </div>
      </div>

      <div class="table-responsive">
        <table class="web-table">
          <thead>
            <tr>
              <th>${AP.t('subst.th.inn')}</th>
              <th>${AP.t('subst.th.class')}</th>
              <th>${AP.t('subst.th.t12')}</th>
              <th>${AP.t('subst.th.metabolites')}</th>
              <th>${AP.t('subst.th.f')}</th>
              <th>${AP.t('subst.th.clearance')}</th>
              <th title="${AP.t('subst.th.equivTip')}">${AP.t('subst.th.equiv')}</th>
              <th>${AP.t('subst.th.ind')}</th>
            </tr>
          </thead>
          <tbody id="substances-tbody"></tbody>
        </table>
      </div>
      <p class="table-footer-note abbr-legend">
        <b>${AP.t('subst.abbr')}</b> ${CLASSES.map(c => `<span class="abbr-item"><b>${c.code === 'NON-D2' ? AP.t('subst.nonD2') : c.code}</b> = ${AP.t(`subst.cls.${classKey(c.code)}Name`).toLowerCase()} (${AP.t(`subst.cls.${classKey(c.code)}Desc`)})</span>`).join(' · ')} ·
        <span class="abbr-item"><b>LAI</b> = ${AP.t('subst.laiTip').toLowerCase()}</span>
      </p>
      <p class="table-footer-note">${AP.t('subst.footer')}</p>
    `;

    const searchInput = document.getElementById('substances-search');
    const filterButtons = host.querySelectorAll('.filter-pills button');
    const tbody = document.getElementById('substances-tbody');
    let currentFilter = 'all';
    let currentQuery = '';

    function updateTable() {
      const q = currentQuery.trim().toLowerCase();
      const filtered = data.filter(d => {
        if (currentFilter === 'lai' && !d.lai) return false;
        if (!['all', 'lai'].includes(currentFilter) && d.code !== currentFilter) return false;
        if (q) {
          const hay = [d.name, d.brand, d.category, d.code, d.indications, d.clearance, d.metabolites].join(' ').toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="table-empty">${AP.t('subst.noMatch')}</td></tr>`;
        return;
      }

      tbody.innerHTML = filtered.map(d => {
        const k = classKey(d.code);
        const active = /^Active/.test(AP.raw.substances.find(s => s.key === d.key).metabolites);   // English original
        return `
        <tr data-drug-key="${d.key}" title="${AP.t('subst.selectAll', { drug: d.name })}">
          <td>
            <b>${d.name}</b>
            ${d.lai ? `<span class="tag-lot" title="${AP.t('subst.laiTip')}">LAI</span>` : ''}
            <small class="cat-extra">${d.brand}</small>
          </td>
          <td><abbr class="badge-cat" style="background:${d.color || '#495057'}" title="${k ? `${AP.t(`subst.cls.${k}Name`)}: ${AP.t(`subst.cls.${k}Desc`)}` : d.category}">${d.code === 'NON-D2' ? AP.t('subst.nonD2') : d.code}</abbr></td>
          <td>${d.tHalf}</td>
          <td>${active ? `<span class="tag-active-met">${d.metabolites}</span>` : `<span>${d.metabolites}</span>`}</td>
          <td>${d.bioavailability}</td>
          <td>${d.clearance}</td>
          <td>${d.olz}</td>
          <td>${d.indications}</td>
        </tr>`;
      }).join('');

      tbody.querySelectorAll('tr[data-drug-key]').forEach(row => {
        row.addEventListener('click', () => {
          const key = row.getAttribute('data-drug-key');
          if (key && AP.drugs[key] && window.syncDrugSelection) window.syncDrugSelection(key, 'table');
        });
      });
    }

    searchInput?.addEventListener('input', e => { currentQuery = e.target.value; updateTable(); });
    filterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        filterButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.getAttribute('data-filter');
        updateTable();
      });
    });

    updateTable();
  }

  return { init };
})();
