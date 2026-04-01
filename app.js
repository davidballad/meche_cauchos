import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let supabase = null;

/** @type {Array<Record<string, unknown>>} */
let allParts = [];

/** @type {Array<Record<string, unknown>>} */
let allTransactions = [];

let warnedTxMissing = false;

const REQUEST_MS = 28000;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Evita que la UI quede en “Cargando…” indefinidamente si la red o Supabase no responden.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} timeoutMessage
 */
function withTimeout(promise, ms, timeoutMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(timeoutMessage)), ms);
    }),
  ]);
}

function formatMoney(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return '—';
  return new Intl.NumberFormat('es', {
    style: 'currency',
    currency: 'USD',
  }).format(num);
}

function isLowStock(row) {
  const qty = Number(row.stock_quantity) || 0;
  const th = Number(row.low_stock_threshold) ?? 5;
  return qty <= th;
}

function showToast(message, type = 'success') {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4000);
}

function setGlobalLoading(on) {
  const ov = $('#global-loading');
  ov.classList.toggle('visible', on);
  ov.setAttribute('aria-hidden', on ? 'false' : 'true');
}

function setSectionLoading(sectionId, on) {
  const map = {
    dashboard: '#dashboard-loading',
    catalog: '#catalog-loading',
    'admin-catalog': '#admin-catalog-loading',
    search: '#search-loading',
    transactions: '#transactions-loading',
  };
  const sel = map[sectionId];
  if (!sel) return;
  const el = $(sel);
  if (el) el.hidden = !on;
}

function clearAllLoadingUI() {
  setGlobalLoading(false);
  setSectionLoading('dashboard', false);
  setSectionLoading('catalog', false);
  setSectionLoading('admin-catalog', false);
  setSectionLoading('search', false);
  setSectionLoading('transactions', false);
}

/** @type {number} */
let scrollSpySuppressUntil = 0;

function setActiveNav(id) {
  $$('.main-nav .nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === id));
}

function showSection(id) {
  setActiveNav(id);
  const sectionEl = $(`#section-${id}`);
  if (sectionEl) {
    scrollSpySuppressUntil = Date.now() + 750;
    sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (id === 'search') renderSearchResults();
}

function initScrollSpy() {
  const header = $('.site-header');
  const panels = $$('.section-panel');
  if (!header || panels.length === 0) return;

  function updateActiveFromScroll() {
    if (Date.now() < scrollSpySuppressUntil) return;
    const offset = header.getBoundingClientRect().height + 16;
    let current = 'dashboard';
    for (const s of panels) {
      const top = s.getBoundingClientRect().top;
      if (top <= offset) current = s.id.replace(/^section-/, '');
    }
    setActiveNav(current);
  }

  let raf = 0;
  window.addEventListener(
    'scroll',
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateActiveFromScroll();
      });
    },
    { passive: true }
  );
  updateActiveFromScroll();
}

function initScrollDrivenMotion() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const stage = $('.stage-3d');
  const mesh = $('.ambient-3d__mesh');
  const glowA = $('.ambient-3d__glow--a');
  const glowB = $('.ambient-3d__glow--b');

  let raf = 0;
  function tick() {
    raf = 0;
    const y = window.scrollY;
    const range = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const p = y / range;

    if (stage) {
      const tilt = (p - 0.5) * -1.4;
      stage.style.transform = `translateZ(0) rotateX(${tilt}deg)`;
    }
    if (mesh) {
      mesh.style.transform = `translate3d(0, ${y * 0.06}px, 0) rotateX(${3 + p * 5}deg) scale(1.08)`;
    }
    if (glowA) {
      glowA.style.transform = `translate3d(${-y * 0.015}px, ${y * 0.1}px, 0) scale(${1 + p * 0.08})`;
    }
    if (glowB) {
      glowB.style.transform = `translate3d(${y * 0.02}px, ${y * 0.04}px, 0) scale(${1.05 - p * 0.05})`;
    }
  }

  window.addEventListener(
    'scroll',
    () => {
      if (!raf) raf = requestAnimationFrame(tick);
    },
    { passive: true }
  );
  tick();
}

function navigateTo(section) {
  showSection(section);
  if (section === 'dashboard') renderDashboard();
  if (section === 'catalog') renderCatalog();
}

async function fetchAppSettings() {
  if (!supabase) return { data: null, error: new Error('Sin cliente') };
  return supabase.from('app_settings').select('admin_user_id').eq('singleton_key', 'default').maybeSingle();
}

async function checkIsAdmin() {
  if (!supabase) return false;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user?.id) return false;
  const { data, error } = await fetchAppSettings();
  if (error || !data) return false;
  return data.admin_user_id === session.user.id;
}

function openAdminPortal() {
  const portal = $('#admin-portal');
  if (!portal) return;
  portal.hidden = false;
  portal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('admin-portal-open');
}

function closeAdminPortal() {
  const portal = $('#admin-portal');
  if (!portal) return;
  portal.hidden = true;
  portal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('admin-portal-open');
}

function showAdminWorkspace() {
  const auth = $('#admin-auth');
  const ws = $('#admin-workspace');
  const logout = $('#admin-logout');
  if (auth) auth.hidden = true;
  if (ws) ws.hidden = false;
  if (logout) logout.hidden = false;
  populateTransactionPartSelect();
  renderTransactionsTable();
  updateTxPartHint();
  renderAdminCatalog();
}

function hideAdminWorkspace() {
  const auth = $('#admin-auth');
  const ws = $('#admin-workspace');
  const logout = $('#admin-logout');
  if (auth) auth.hidden = false;
  if (ws) ws.hidden = true;
  if (logout) logout.hidden = true;
}

/** @param {'catalog'|'transactions'|'form'} slug */
function goToAdminSection(slug) {
  const id = `admin-section-${slug}`;
  const el = document.getElementById(id);
  $$('.admin-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.adminSection === slug));
  scrollSpySuppressUntil = Date.now() + 400;
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setActiveAdminNavFromScroll() {
  const wrap = $('#admin-workspace .admin-workspace__scroll');
  if (!wrap) return;
  const panels = $$('.admin-section-panel', wrap);
  const mid = wrap.getBoundingClientRect().top + 100;
  let current = 'catalog';
  for (const s of panels) {
    if (s.getBoundingClientRect().top <= mid) {
      const id = s.id.replace(/^admin-section-/, '');
      current = id;
    }
  }
  $$('.admin-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.adminSection === current));
}

async function syncAdminPortalAuth() {
  if (!supabase) return;

  const intro = $('#admin-auth-intro');
  const setupForm = $('#admin-setup-form');
  const loginForm = $('#admin-login-form');

  const { data: settings, error: settingsError } = await fetchAppSettings();

  if (settingsError) {
    if (intro) {
      intro.textContent =
        'No se pudo leer la configuración del sitio. Si aún no lo has hecho, ejecuta supabase_migration_admin_auth.sql en el SQL Editor de Supabase.';
    }
    if (setupForm) setupForm.hidden = true;
    if (loginForm) loginForm.hidden = true;
    hideAdminWorkspace();
    return;
  }

  const needsSetup = !settings?.admin_user_id;

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (needsSetup && session) {
    const claim = await supabase.rpc('claim_admin_slot');
    if (claim.error) {
      if (intro) intro.textContent = claim.error.message || 'No se pudo completar el registro de administrador.';
      if (setupForm) setupForm.hidden = true;
      if (loginForm) loginForm.hidden = false;
      hideAdminWorkspace();
      await supabase.auth.signOut();
      showToast('Otra cuenta ya es la administradora o el registro falló.', 'error');
      return;
    }
    if (intro) intro.textContent = '';
    if (setupForm) setupForm.hidden = true;
    if (loginForm) loginForm.hidden = true;
    showToast('Administrador activado.');
    await refreshAllData();
    showAdminWorkspace();
    return;
  }

  if (needsSetup) {
    hideAdminWorkspace();
    if (intro) intro.textContent = 'Configura la cuenta de administrador (solo se permite una).';
    if (setupForm) setupForm.hidden = false;
    if (loginForm) loginForm.hidden = true;
    return;
  }

  if (!session) {
    hideAdminWorkspace();
    if (intro) intro.textContent = 'Inicia sesión con el correo del administrador.';
    if (setupForm) setupForm.hidden = true;
    if (loginForm) loginForm.hidden = false;
    return;
  }

  const isAdm = await checkIsAdmin();
  if (!isAdm) {
    if (intro) {
      intro.textContent = 'Esta cuenta no es el administrador de este sitio.';
    }
    if (setupForm) setupForm.hidden = true;
    if (loginForm) loginForm.hidden = false;
    hideAdminWorkspace();
    await supabase.auth.signOut();
    showToast('Solo la cuenta de administración puede acceder al panel.', 'error');
    return;
  }

  if (intro) intro.textContent = '';
  if (setupForm) setupForm.hidden = true;
  if (loginForm) loginForm.hidden = true;
  showAdminWorkspace();
}

async function refreshAllData() {
  if (!supabase) {
    clearAllLoadingUI();
    return;
  }

  let userIsAdmin = false;
  try {
    userIsAdmin = await checkIsAdmin();
  } catch (err) {
    console.error(err);
    userIsAdmin = false;
  }

  setGlobalLoading(true);
  setSectionLoading('dashboard', true);
  setSectionLoading('catalog', true);
  setSectionLoading('admin-catalog', userIsAdmin);
  setSectionLoading('search', true);
  setSectionLoading('transactions', userIsAdmin);

  try {
    const partsOutcome = await withTimeout(
      supabase.from('parts').select('*').order('name', { ascending: true }),
      REQUEST_MS,
      'Tiempo de espera al cargar repuestos. Comprueba la red, la URL de Supabase en config.js y que el proyecto esté activo.'
    );

    const { data: partsData, error: partsError } = partsOutcome;

    if (partsError) {
      console.error(partsError);
      showToast(`Error al cargar datos: ${partsError.message}`, 'error');
      allParts = [];
    } else {
      allParts = partsData || [];
    }

    let txRows = [];
    if (userIsAdmin) {
      try {
        const txOutcome = await withTimeout(
          supabase.from('transactions').select('*').order('created_at', { ascending: false }).limit(200),
          REQUEST_MS,
          'Tiempo de espera al cargar transacciones.'
        );
        const { data: txData, error: txError } = txOutcome;
        if (txError) {
          console.error(txError);
          if (!warnedTxMissing) {
            warnedTxMissing = true;
            showToast(
              `Transacciones no disponibles: ${txError.message}. Si acabas de actualizar la app, ejecuta las migraciones SQL en Supabase.`,
              'error'
            );
          }
        } else {
          txRows = txData || [];
        }
      } catch (txErr) {
        console.error(txErr);
        if (!warnedTxMissing) {
          warnedTxMissing = true;
          showToast(
            txErr instanceof Error ? txErr.message : 'No se pudieron cargar las transacciones.',
            'error'
          );
        }
      }
    } else {
      allTransactions = [];
    }
    if (userIsAdmin) {
      allTransactions = txRows;
    }

    renderDashboard();
    renderCatalog();
    renderAdminCatalog();
    populateBrandFilter();
    renderSearchResults();
    populateTransactionPartSelect();
    renderTransactionsTable();
  } catch (err) {
    console.error(err);
    showToast(err instanceof Error ? err.message : 'Error al cargar datos.', 'error');
    allParts = [];
    allTransactions = [];
    renderDashboard();
    renderCatalog();
    renderAdminCatalog();
    populateBrandFilter();
    renderSearchResults();
    populateTransactionPartSelect();
    renderTransactionsTable();
  } finally {
    clearAllLoadingUI();
  }
}

function renderDashboard() {
  const count = allParts.length;
  const value = allParts.reduce((sum, p) => {
    const price = Number(p.price) || 0;
    const qty = Number(p.stock_quantity) || 0;
    return sum + price * qty;
  }, 0);

  $('#stat-count').textContent = String(count);
  $('#stat-value').textContent = formatMoney(value);

  const low = allParts.filter(isLowStock);
  const list = $('#low-stock-list');
  const empty = $('#low-stock-empty');
  list.innerHTML = '';

  if (low.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  low.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span><span class="pn">${escapeHtml(String(p.part_number))}</span> — ${escapeHtml(String(p.name))}</span>
      <span class="stock">Stock: ${escapeHtml(String(p.stock_quantity))} (umbral: ${escapeHtml(String(p.low_stock_threshold ?? 5))})</span>
    `;
    list.appendChild(li);
  });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function buildPartCard(p, { showActions = true } = {}) {
  const card = document.createElement('article');
  card.className = 'part-card';
  const low = isLowStock(p);
  const stockClass = low ? 'stock low' : 'stock';

  card.innerHTML = `
    <div class="part-number">${escapeHtml(String(p.part_number))}</div>
    <h3>${escapeHtml(String(p.name))}</h3>
    <div class="meta">${escapeHtml(String(p.brand || '—'))} · ${escapeHtml(String(p.category || '—'))}</div>
    <div class="price">${formatMoney(p.price)}</div>
    <div class="${stockClass}">Stock: ${escapeHtml(String(p.stock_quantity ?? 0))}</div>
    ${
      showActions
        ? `<div class="part-card-actions">
        <button type="button" class="btn btn-secondary btn-edit" data-id="${escapeHtml(String(p.id))}">Editar</button>
        <button type="button" class="btn btn-danger btn-delete" data-id="${escapeHtml(String(p.id))}">Eliminar</button>
      </div>`
        : ''
    }
  `;

  if (showActions) {
    card.querySelector('.btn-edit')?.addEventListener('click', () => startEdit(p.id));
    card.querySelector('.btn-delete')?.addEventListener('click', () => confirmDelete(p));
  }
  return card;
}

function renderCatalog() {
  const grid = $('#catalog-grid');
  const empty = $('#catalog-empty');
  grid.innerHTML = '';

  if (allParts.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  allParts.forEach((p) => grid.appendChild(buildPartCard(p, { showActions: false })));
}

function renderAdminCatalog() {
  const grid = $('#admin-catalog-grid');
  const empty = $('#admin-catalog-empty');
  if (!grid || !empty) return;
  grid.innerHTML = '';

  if (allParts.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  allParts.forEach((p) => grid.appendChild(buildPartCard(p, { showActions: true })));
}

function populateBrandFilter() {
  const sel = $('#filter-brand');
  const current = sel.value;
  const brands = [...new Set(allParts.map((p) => p.brand).filter(Boolean))].sort((a, b) =>
    String(a).localeCompare(String(b), 'es')
  );
  sel.innerHTML = '<option value="">Todas</option>';
  brands.forEach((b) => {
    const opt = document.createElement('option');
    opt.value = String(b);
    opt.textContent = String(b);
    sel.appendChild(opt);
  });
  const hasCurrent = [...sel.options].some((o) => o.value === current);
  sel.value = hasCurrent ? current : '';
}

function populateTransactionPartSelect() {
  const sel = $('#tx-part');
  if (!sel) return;
  const current = sel.value;
  const withStock = allParts.filter((p) => (Number(p.stock_quantity) || 0) > 0);
  sel.innerHTML = '<option value="">— Selecciona un repuesto con stock —</option>';
  withStock.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    opt.textContent = `${p.part_number} — ${p.name} (stock: ${p.stock_quantity})`;
    sel.appendChild(opt);
  });
  const hasCurrent = [...sel.options].some((o) => o.value === current);
  sel.value = hasCurrent ? current : '';
}

function updateTxPartHint() {
  const id = $('#tx-part')?.value;
  const qty = $('#tx-qty');
  const hint = $('#tx-stock-hint');
  if (!qty || !hint) return;
  if (!id) {
    hint.textContent = '';
    qty.removeAttribute('max');
    return;
  }
  const p = allParts.find((x) => x.id === id);
  const stock = p ? Number(p.stock_quantity) || 0 : 0;
  if (stock > 0) {
    qty.setAttribute('max', String(stock));
    hint.textContent = `Stock disponible: ${stock}`;
  } else {
    qty.setAttribute('max', '0');
    hint.textContent = 'Sin stock para este repuesto.';
  }
}

function renderTransactionsTable() {
  const tbody = $('#transactions-tbody');
  const empty = $('#transactions-empty');
  const table = $('#transactions-table');
  if (!tbody || !empty || !table) return;
  tbody.innerHTML = '';

  if (allTransactions.length === 0) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }
  empty.hidden = true;
  table.hidden = false;

  const fmtDate = (iso) => {
    try {
      return new Date(String(iso)).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      return '—';
    }
  };

  for (const tx of allTransactions) {
    const part = allParts.find((p) => p.id === tx.part_id);
    const pn = part ? String(part.part_number) : '—';
    const nm = part ? String(part.name) : '(repuesto no cargado)';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(fmtDate(tx.created_at))}</td>
      <td>${escapeHtml(pn)}</td>
      <td>${escapeHtml(nm)}</td>
      <td class="num">${escapeHtml(String(tx.quantity ?? '—'))}</td>
      <td class="num">${escapeHtml(formatMoney(tx.total))}</td>
      <td>${escapeHtml(tx.notes ? String(tx.notes) : '—')}</td>
    `;
    tbody.appendChild(tr);
  }
}

function getFilteredParts() {
  const q = ($('#filter-q').value || '').trim().toLowerCase();
  const cat = $('#filter-category').value;
  const brand = $('#filter-brand').value;

  return allParts.filter((p) => {
    if (cat && String(p.category || '') !== cat) return false;
    if (brand && String(p.brand || '') !== brand) return false;
    if (!q) return true;
    const name = String(p.name || '').toLowerCase();
    const pn = String(p.part_number || '').toLowerCase();
    const br = String(p.brand || '').toLowerCase();
    return name.includes(q) || pn.includes(q) || br.includes(q);
  });
}

function renderSearchResults() {
  const grid = $('#search-grid');
  const empty = $('#search-empty');
  grid.innerHTML = '';
  const filtered = getFilteredParts();

  if (filtered.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  filtered.forEach((p) => grid.appendChild(buildPartCard(p, { showActions: false })));
}

function resetForm() {
  $('#part-form').reset();
  $('#field-id').value = '';
  $('#field-stock_quantity').value = '0';
  $('#field-low_stock_threshold').value = '5';
  $('#form-title').textContent = 'Añadir o editar repuesto';
  $('#form-submit-btn').textContent = 'Guardar';
}

function startEdit(id) {
  const p = allParts.find((x) => x.id === id);
  if (!p) return;
  $('#field-id').value = String(p.id);
  $('#field-part_number').value = String(p.part_number ?? '');
  $('#field-name').value = String(p.name ?? '');
  $('#field-category').value = String(p.category ?? '');
  $('#field-brand').value = String(p.brand ?? '');
  $('#field-price').value = p.price != null ? String(p.price) : '';
  $('#field-stock_quantity').value = String(p.stock_quantity ?? 0);
  $('#field-low_stock_threshold').value = String(p.low_stock_threshold ?? 5);
  $('#field-description').value = String(p.description ?? '');
  $('#form-title').textContent = 'Editar repuesto';
  $('#form-submit-btn').textContent = 'Actualizar';
  openAdminPortal();
  syncAdminPortalAuth().then(async () => {
    if (await checkIsAdmin()) {
      goToAdminSection('form');
      $('#field-part_number').focus();
    }
  });
}

async function confirmDelete(p) {
  if (!supabase) return;
  const ok = window.confirm(
    `¿Eliminar el repuesto "${p.name}" (${p.part_number})? Esta acción no se puede deshacer.`
  );
  if (!ok) return;

  setGlobalLoading(true);
  try {
    const { error } = await supabase.from('parts').delete().eq('id', p.id);
    if (error) {
      showToast(`Error al eliminar: ${error.message}`, 'error');
      return;
    }
    showToast('Repuesto eliminado correctamente.');
    await refreshAllData();
  } finally {
    setGlobalLoading(false);
  }
}

function wireEventListeners() {
  $('#part-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!supabase) return;
    if (!(await checkIsAdmin())) {
      showToast('Debes iniciar sesión como administrador.', 'error');
      return;
    }

    const id = $('#field-id').value.trim();
    const part_number = $('#field-part_number').value.trim();
    const name = $('#field-name').value.trim();
    const category = $('#field-category').value || null;
    const brand = $('#field-brand').value.trim() || null;
    const priceRaw = $('#field-price').value;
    const price = priceRaw === '' ? null : Number(priceRaw);
    const stock_quantity = parseInt($('#field-stock_quantity').value, 10) || 0;
    const low_stock_threshold = parseInt($('#field-low_stock_threshold').value, 10) || 0;
    const description = $('#field-description').value.trim() || null;

    const payload = {
      part_number,
      name,
      category,
      brand,
      price,
      stock_quantity,
      low_stock_threshold,
      description,
    };

    setGlobalLoading(true);
    try {
      let error;
      if (id) {
        const res = await supabase.from('parts').update(payload).eq('id', id);
        error = res.error;
      } else {
        const res = await supabase.from('parts').insert([payload]);
        error = res.error;
      }
      if (error) {
        showToast(`Error al guardar: ${error.message}`, 'error');
        return;
      }
      showToast(id ? 'Repuesto actualizado correctamente.' : 'Repuesto creado correctamente.');
      resetForm();
      await refreshAllData();
      goToAdminSection('catalog');
    } finally {
      setGlobalLoading(false);
    }
  });

  $('#form-reset-btn').addEventListener('click', () => resetForm());

  $$('.main-nav .nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.section));
  });

  $('#admin-open')?.addEventListener('click', () => {
    openAdminPortal();
    syncAdminPortalAuth();
  });

  $('#admin-close')?.addEventListener('click', () => closeAdminPortal());
  $('#admin-backdrop')?.addEventListener('click', () => closeAdminPortal());

  $('#admin-workspace .admin-workspace__scroll')?.addEventListener(
    'scroll',
    () => requestAnimationFrame(setActiveAdminNavFromScroll),
    { passive: true }
  );

  $$('.admin-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => goToAdminSection(btn.dataset.adminSection));
  });

  $('#admin-logout')?.addEventListener('click', async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    hideAdminWorkspace();
    await syncAdminPortalAuth();
    await refreshAllData();
    showToast('Sesión cerrada.');
  });

  $('#admin-setup-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!supabase) return;
    const email = $('#setup-email').value.trim();
    const pw = $('#setup-password').value;
    const pw2 = $('#setup-password2').value;
    if (pw !== pw2) {
      showToast('Las contraseñas no coinciden.', 'error');
      return;
    }
    setGlobalLoading(true);
    try {
      const { data, error } = await supabase.auth.signUp({ email, password: pw });
      if (error) {
        showToast(error.message, 'error');
        return;
      }
      if (!data.session) {
        showToast(
          'Cuenta creada. Si Supabase exige confirmar el correo, abre el enlace del email y vuelve a entrar aquí con Administración.',
          'success'
        );
        return;
      }
      const claim = await supabase.rpc('claim_admin_slot');
      if (claim.error) {
        showToast(claim.error.message || 'No se pudo registrar el administrador.', 'error');
        await supabase.auth.signOut();
        return;
      }
      showToast('Administrador configurado. Ya puedes gestionar inventario.');
      await refreshAllData();
      await syncAdminPortalAuth();
    } finally {
      setGlobalLoading(false);
    }
  });

  $('#admin-login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!supabase) return;
    const email = $('#login-email').value.trim();
    const password = $('#login-password').value;
    setGlobalLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        showToast(error.message, 'error');
        return;
      }
      await refreshAllData();
      await syncAdminPortalAuth();
    } finally {
      setGlobalLoading(false);
    }
  });

  initScrollSpy();
  initScrollDrivenMotion();

  $('#brand-link').addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('dashboard');
  });

  $('#filter-q').addEventListener('input', () => renderSearchResults());
  $('#filter-category').addEventListener('change', () => renderSearchResults());
  $('#filter-brand').addEventListener('change', () => renderSearchResults());

  $('#tx-part').addEventListener('change', () => updateTxPartHint());
  $('#tx-qty').addEventListener('input', () => updateTxPartHint());

  $('#transaction-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!supabase) return;
    if (!(await checkIsAdmin())) {
      showToast('Debes iniciar sesión como administrador.', 'error');
      return;
    }

    const partId = $('#tx-part').value;
    const qty = parseInt($('#tx-qty').value, 10) || 0;
    const notesRaw = $('#tx-notes').value.trim();
    const notes = notesRaw === '' ? null : notesRaw;

    if (!partId) {
      showToast('Selecciona un repuesto.', 'error');
      return;
    }
    const p = allParts.find((x) => x.id === partId);
    const stock = p ? Number(p.stock_quantity) || 0 : 0;
    if (qty < 1) {
      showToast('La cantidad debe ser al menos 1.', 'error');
      return;
    }
    if (qty > stock) {
      showToast(`Stock insuficiente (disponible: ${stock}).`, 'error');
      return;
    }

    setGlobalLoading(true);
    try {
      const rpcPromise = supabase.rpc('create_transaction_sale', {
        p_part_id: partId,
        p_quantity: qty,
        p_notes: notes,
      });
      const { error } = await withTimeout(
        rpcPromise,
        REQUEST_MS,
        'Tiempo de espera al registrar la transacción.'
      );
      if (error) {
        showToast(`Error: ${error.message}`, 'error');
        return;
      }
      showToast('Transacción registrada. El inventario se ha actualizado.');
      $('#tx-notes').value = '';
      $('#tx-qty').value = '1';
      await refreshAllData();
      goToAdminSection('transactions');
    } catch (err) {
      console.error(err);
      showToast(err instanceof Error ? err.message : 'Error al registrar la transacción.', 'error');
    } finally {
      setGlobalLoading(false);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#admin-portal')?.hidden) {
      closeAdminPortal();
    }
  });
}

async function bootstrap() {
  let supabaseUrl;
  let supabaseAnonKey;

  try {
    const mod = await import('./config.js');
    supabaseUrl = mod.supabaseUrl;
    supabaseAnonKey = mod.supabaseAnonKey;
  } catch (err) {
    console.error(err);
    clearAllLoadingUI();
    showToast(
      'No se pudo cargar config.js (suele ser un 404). Asegúrate de que exista en el sitio publicado o configura el workflow de GitHub Actions con los secretos SUPABASE_URL y SUPABASE_ANON_KEY.',
      'error'
    );
    return;
  }

  if (!supabaseUrl || !supabaseAnonKey || String(supabaseUrl).includes('TU-PROYECTO')) {
    clearAllLoadingUI();
    showToast(
      'Configura config.js con la URL y la clave anónima de Supabase (copia desde config.example.js).',
      'error'
    );
    return;
  }

  supabase = createClient(supabaseUrl, supabaseAnonKey);
  supabase.auth.onAuthStateChange(() => {
    refreshAllData();
    const portal = $('#admin-portal');
    if (portal && !portal.hidden) syncAdminPortalAuth();
  });

  wireEventListeners();
  await refreshAllData();
}

bootstrap();
