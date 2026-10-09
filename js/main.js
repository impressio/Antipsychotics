/* =====================================================================
 * main.js - Application entry point and coordination
 * ===================================================================== */
document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  // Centralized Drug Selection Synchronizer
  let isSyncingDrug = false;

  window.syncDrugSelection = function (drugKey, sourceId) {
    if (!drugKey || isSyncingDrug) return;
    isSyncingDrug = true;

    try {
      const mSel = document.getElementById('m-ligand');
      const pdSel = document.getElementById('pd-drug');
      const pkSel = document.getElementById('pk-drug');

      // 1. Sync Mechanism ligand select
      if (mSel) {
        const hasOpt = Array.from(mSel.options).some(o => o.value === drugKey);
        if (hasOpt && mSel.value !== drugKey) {
          mSel.value = drugKey;
        }
        if (window.Receptor && typeof window.Receptor.update === 'function') {
          window.Receptor.update();
        }
      }

      // 2. Sync Pharmacodynamics drug select
      if (pdSel) {
        const hasOpt = Array.from(pdSel.options).some(o => o.value === drugKey);
        if (hasOpt && pdSel.value !== drugKey) {
          pdSel.value = drugKey;
        }
        if (window.PD && typeof window.PD.update === 'function') {
          window.PD.update();
        }
      }

      // 3. Sync Pharmacokinetics drug select
      if (pkSel) {
        const hasOpt = Array.from(pkSel.options).some(o => o.value === drugKey);
        if (hasOpt) {
          if (pkSel.value !== drugKey) {
            pkSel.value = drugKey;
          }
          const d = window.AP?.drugs?.[drugKey];
          if (d && d.pk) {
            const route = (window.PK && typeof window.PK.syncRouteOptions === 'function')
              ? window.PK.syncRouteOptions(drugKey)
              : (document.getElementById('pk-route')?.value || 'oral');
            if (window.PK && typeof window.PK.applyRegimen === 'function') window.PK.applyRegimen(drugKey, route);
          }
          if (window.PK && typeof window.PK.update === 'function') {
            window.PK.update();
          }
        }
      }

      // Mechanism and Pharmacodynamics share the synaptic-dopamine setting
      const mDa = document.getElementById('m-da'), pdDa = document.getElementById('pd-da');
      if (mDa && pdDa && pdDa.value !== mDa.value) pdDa.value = mDa.value;

      highlightDrugElements(drugKey);
    } catch (err) {
      console.error('Error syncing drug selection:', err);
    } finally {
      isSyncingDrug = false;
    }
  };

  // Centralized Route Selection Synchronizer.
  // The selected route lives in #pk-route; this applies a route chosen anywhere
  // (route bars/table, PK dropdown) to the PK simulator and the routes section.
  let isSyncingRoute = false;
  const PREFERRED_DRUG_FOR_ROUTE = {
    oral: 'risperidone', odt: 'olanzapine', im: 'haloperidol', iv: 'haloperidol', lai: 'paliperidone'
  };

  window.syncRouteSelection = function (routeId, sourceId) {
    if (!routeId || isSyncingRoute) return;
    isSyncingRoute = true;

    try {
      const pkRoute = document.getElementById('pk-route');
      const pkDrug = document.getElementById('pk-drug');
      let drugKey = pkDrug?.value || 'risperidone';
      let drug = window.AP.drugs[drugKey];
      const routeName = (window.AP.routes.find(r => r.id === routeId) || {}).name || routeId;
      const allowed = (drug && drug.routes) || ['oral'];
      let notice = '';

      if (!allowed.includes(routeId)) {
        // Selected drug has no such formulation -> switch to a drug that does
        const pref = PREFERRED_DRUG_FOR_ROUTE[routeId];
        const cand = (pref && (window.AP.drugs[pref].routes || []).includes(routeId))
          ? pref
          : Object.keys(window.AP.drugs).find(k => window.AP.drugs[k].pk && (window.AP.drugs[k].routes || []).includes(routeId));
        if (cand) {
          notice = AP.t('main.routeSwitched', { route: routeName, drug: drug.name, other: window.AP.drugs[cand].name });
          isSyncingRoute = false;               // allow the nested drug sync
          window.syncDrugSelection(cand, 'route');
          isSyncingRoute = true;
          drugKey = cand;
          drug = window.AP.drugs[cand];
        } else {
          routeId = drug.defaultRoute || 'oral';
        }
      }

      if (pkRoute) {
        if (window.PK && window.PK.syncRouteOptions) window.PK.syncRouteOptions(drugKey);
        pkRoute.value = routeId;
      }
      if (window.Routes) window.Routes.setNotice(routeId, drugKey, notice);
      if (window.PK && window.PK.update) window.PK.update();
      else if (window.Routes) window.Routes.reflect(routeId, drugKey);
    } catch (err) {
      console.error('Error syncing route selection:', err);
    } finally {
      isSyncingRoute = false;
    }
  };

  function highlightDrugElements(drugKey) {
    document.querySelectorAll('.lig-card[data-drug-key]').forEach(c => {
      c.classList.toggle('selected-drug', c.getAttribute('data-drug-key') === drugKey);
    });

    document.querySelectorAll('#substances-tbody tr[data-drug-key]').forEach(r => {
      r.classList.toggle('selected-drug', r.getAttribute('data-drug-key') === drugKey);
    });
  }

  // Centralized Pathway Selection Synchronizer: the mechanism section (pathway and its dopamine
  // level) and the pathway overlay of the distribution map show the same pathway
  let isSyncingPath = false;
  window.syncPathwaySelection = function (key, sourceId) {
    if (!key || isSyncingPath || !AP.pathways[key]) return;
    isSyncingPath = true;
    try {
      const sel = document.getElementById('m-path'), da = document.getElementById('m-da');
      if (sel && sel.value !== key) sel.value = key;
      if (da) da.value = String(AP.pathways[key].da);
      if (window.Receptor) { window.Receptor.showInfo('pathway'); window.Receptor.update(); }
      if (window.Distribution && window.Distribution.setPathway) window.Distribution.setPathway(key);
    } catch (err) {
      console.error('Error syncing pathway selection:', err);
    } finally {
      isSyncingPath = false;
    }
  };

  // Centralized Target Selection Synchronizer (the receptor shown in the distribution map)
  let isSyncingTarget = false;

  window.syncTargetSelection = function (targetKey, sourceId) {
    if (!targetKey || isSyncingTarget) return;
    isSyncingTarget = true;
    try {
      if (window.Distribution) window.Distribution.update(targetKey);
      document.querySelectorAll('.sub-effect-card[data-target-key]').forEach(c => {
        c.classList.toggle('active-isoform', c.getAttribute('data-target-key') === targetKey);
      });
    } catch (err) {
      console.error('Error syncing target selection:', err);
    } finally {
      isSyncingTarget = false;
    }
  };

  // Load the domain data (assets/data/properties.json) and interface texts first, then start the modules
  AP.load().then(() => {
    AP.translatePage();
    AP.initSettings();
    try { if (window.Receptor) window.Receptor.init(); } catch (e) { console.error('Receptor init error:', e); }
    try { if (window.Substrates) window.Substrates.init(); } catch (e) { console.error('Substrates init error:', e); }
    try { if (window.Routes) window.Routes.init(); } catch (e) { console.error('Routes init error:', e); }
    try { if (window.Distribution) window.Distribution.init(); } catch (e) { console.error('Distribution init error:', e); }
    try { if (window.PD) window.PD.init(); } catch (e) { console.error('PD init error:', e); }
    try { if (window.PK) window.PK.init(); } catch (e) { console.error('PK init error:', e); }
    try { if (window.Structure) window.Structure.init(); } catch (e) { console.error('Structure init error:', e); }

    // Set initial highlights and mirror the initial route into the routes section
    highlightDrugElements('risperidone');
    window.syncPathwaySelection(document.getElementById('m-path')?.value || 'mesolimbic', 'init');
    try {
      const d0 = document.getElementById('pk-drug')?.value || 'risperidone';
      if (window.PK && window.PK.syncRouteOptions) window.PK.syncRouteOptions(d0);
      if (window.Routes) window.Routes.reflect(document.getElementById('pk-route')?.value || 'oral', d0);
    } catch (e) { console.error('Initial route sync error:', e); }
  }).catch(err => {
    console.error('Data loading error:', err);
    const main = document.querySelector('main');
    if (main) main.insertAdjacentHTML('afterbegin', `<div class="card data-error"><b>${AP.t('main.dataError')}</b> ${err.message}</div>`);
  });

  // Number fields: typed values are applied once typing pauses (or on Enter / leaving the field),
  // so entering "20" does not first simulate "2"; spinner arrows and the mouse wheel apply at once.
  // Empty or invalid entries are not applied. Implemented once here, in the capture phase, for all modules.
  const NUM_SETTLE_MS = 700;
  const isNumberField = (el) => el instanceof HTMLInputElement && el.type === 'number';
  const settleNumber = (el) => {
    clearTimeout(el._numTimer); el._numTimer = null;
    if (el.value === '' || !el.checkValidity()) return;
    const ev = new Event('input', { bubbles: true });
    ev.numberSettled = true;
    el.dispatchEvent(ev);
  };
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!isNumberField(el) || e.numberSettled) return;
    if (!e.inputType || e.inputType === 'insertReplacementText') return; // stepper / wheel: apply now
    e.stopImmediatePropagation();
    clearTimeout(el._numTimer);
    el._numTimer = setTimeout(() => settleNumber(el), NUM_SETTLE_MS);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && isNumberField(e.target) && e.target._numTimer) settleNumber(e.target);
  }, true);
  document.addEventListener('change', (e) => {
    if (isNumberField(e.target) && e.target._numTimer) settleNumber(e.target);
  }, true);

  // Section anchors land exactly under the sticky header (its height varies with screen width)
  const topbar = document.querySelector('.topbar');
  const setTopbarHeight = () => {
    if (topbar) document.documentElement.style.setProperty('--topbar-h', `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
  };
  setTopbarHeight();
  if (topbar) new ResizeObserver(setTopbarHeight).observe(topbar);

  // Compact menu: one button on the right opens the section list (closes on choice, Escape or
  // outside click). It shows the menu icon above the first section and the current section below.
  const menuBtn = document.getElementById('menu-toggle');
  const menuLabel = menuBtn && menuBtn.querySelector('.menu-label');
  const siteNav = document.getElementById('site-nav');
  const setSubtitle = (id) => {
    const link = id && document.querySelector(`header nav a[href="#${id}"]`);
    const label = link ? link.textContent : '';
    if (!menuLabel || menuLabel.textContent === label) return;
    menuLabel.textContent = label;
    menuBtn.classList.toggle('has-label', !!label);
  };
  const setMenu = (open) => {
    if (!menuBtn || !siteNav) return;
    siteNav.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', `${AP.t(open ? 'main.closeMenu' : 'main.openMenu')}${menuLabel && menuLabel.textContent ? ` (${menuLabel.textContent})` : ''}`);
  };
  // the logo returns to the top of the page
  const home = document.getElementById('brand-home');
  if (home) home.addEventListener('click', (e) => {
    e.preventDefault();
    setMenu(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  if (menuBtn) menuBtn.addEventListener('click', () => setMenu(!siteNav.classList.contains('open')));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  document.addEventListener('click', (e) => { if (siteNav && siteNav.classList.contains('open') && !e.target.closest('.topbar')) setMenu(false); });

  // Smooth scrolling for navigation links
  document.querySelectorAll('header nav a[href^="#"]').forEach(link => {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      setMenu(false);
      setSubtitle(this.getAttribute('href').slice(1));
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // Highlight active nav item on scroll
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('header nav a');

  window.addEventListener('scroll', () => {
    let current = '';
    const scrollY = window.pageYOffset;
    sections.forEach(sec => {
      const top = sec.offsetTop - 120;
      const height = sec.offsetHeight;
      if (scrollY >= top && scrollY < top + height) {
        current = sec.getAttribute('id');
      }
    });

    navLinks.forEach(link => {
      link.classList.remove('active');
      if (link.getAttribute('href') === `#${current}`) {
        link.classList.add('active');
      }
    });
    setSubtitle(current);
  }, { passive: true });
});
