import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let supabase = null;

/** @type {Array<Record<string, unknown>>} */
let allParts = [];

/** @type {Array<Record<string, unknown>>} */
let allTransactions = [];
let currentSaleCart = []; // Shopping cart for new sales

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
  if (!container) {
    console.warn('Toast:', message);
    return;
  }
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
  ov?.classList.toggle('visible', on);
  ov?.setAttribute('aria-hidden', on ? 'false' : 'true');
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

function navigateTo(id) {
  // Hide all sections
  $$('.section').forEach(s => {
    s.classList.remove('active');
  });

  const target = $(`#section-${id}`);
  if (target) {
    target.classList.add('active');
    setActiveNav(id);
    window.location.hash = id;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (id === 'catalog') renderCatalog();
  if (id === 'admin') syncAdminPortalAuth();
}

function handleHash() {
  const hash = window.location.hash.replace('#', '') || 'catalog';
  navigateTo(hash);
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
      // Disable tilt for admin section to ensure stable click targets
      if (window.location.hash === '#admin') {
        stage.style.transform = 'translateZ(0) rotateX(0deg)';
      } else {
        const tilt = (p - 0.5) * -1.4;
        stage.style.transform = `translateZ(0) rotateX(${tilt}deg)`;
      }
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

function openAdminPortal() {
  navigateTo('admin');
}

function closeAdminPortal() {
  navigateTo('dashboard');
}

function showAuthModal(show = true) {
  const modal = $('#auth-modal');
  if (modal) modal.classList.toggle('visible', show);
}

function showAdminWorkspace() {
  const auth = $('#auth-modal'); // We use modal for auth now
  const ws = $('#admin-workspace');
  showAuthModal(false);
  if (ws) ws.hidden = false;
  populateTransactionPartSelect();
  renderTransactionsTable();
  updateTxPartHint();
  renderAdminCatalog();
}

function hideAdminWorkspace() {
  const ws = $('#admin-workspace');
  if (ws) ws.hidden = true;
}

/** @param {'catalog'|'transactions'|'form'} slug */
function goToAdminSection(slug) {
  $$('.admin-section').forEach(s => s.classList.remove('active'));
  const target = $(`#admin-section-${slug}`);
  if (target) target.classList.add('active');

  $$('.admin-nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.adminSection === slug));

  if (slug === 'dashboard') renderDashboard();
}

function showAdminLoginForm() {
  const setupForm = $('#admin-setup-form');
  const loginForm = $('#admin-login-form');
  const intro = $('#admin-auth-intro');
  if (setupForm) setupForm.hidden = true;
  if (loginForm) loginForm.hidden = false;
  if (intro) intro.textContent = 'Inicia sesión con la cuenta de administrador.';
}

function showAdminSetupForm() {
  const setupForm = $('#admin-setup-form');
  const loginForm = $('#admin-login-form');
  const intro = $('#admin-auth-intro');
  if (setupForm) setupForm.hidden = false;
  if (loginForm) loginForm.hidden = true;
  if (intro) intro.textContent = 'Configura la cuenta de administrador única.';
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

async function syncAdminPortalAuth() {
  if (!supabase) return;

  const intro = $('#admin-auth-intro');
  const setupForm = $('#admin-setup-form');
  const loginForm = $('#admin-login-form');

  const { data: settings, error: settingsError } = await fetchAppSettings();

  if (settingsError) {
    showToast('Error de configuración.', 'error');
    return;
  }

  const needsSetup = !settings?.admin_user_id;
  const { data: { session } } = await supabase.auth.getSession();

  if (needsSetup && session) {
    const claim = await supabase.rpc('claim_admin_slot');
    if (claim.error) {
      showAuthModal(true);
      showAdminLoginForm();
      await supabase.auth.signOut();
      return;
    }
    showAdminWorkspace();
    return;
  }

  if (needsSetup) {
    hideAdminWorkspace();
    showAuthModal(true);
    showAdminSetupForm();
    return;
  }

  if (!session) {
    hideAdminWorkspace();
    showAuthModal(true);
    showAdminLoginForm();
    return;
  }

  const isAdm = await checkIsAdmin();
  if (!isAdm) {
    showAuthModal(true);
    showAdminLoginForm();
    await supabase.auth.signOut();
    showToast('Acceso denegado.', 'error');
    return;
  }

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
      console.log('Parts loaded successfully:', allParts.length);
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
    populateAdminCategoryFilter();
    populateTransactionPartSelect();
    renderTransactionsTable();
  } catch (err) {
    console.error(err);
    showToast('Error al cargar datos.', 'error');
    allParts = [];
    allTransactions = [];
    renderDashboard();
    renderCatalog();
    renderAdminCatalog();
    populateBrandFilter();
    populateAdminCategoryFilter();
    populateTransactionPartSelect();
    renderTransactionsTable();
  } finally {
    clearAllLoadingUI();
  }
}

function renderDashboard() {
  const activeParts = allParts.filter(p => p.is_active !== false);
  const count = activeParts.length;
  const value = activeParts.reduce((sum, p) => {
    const price = Number(p.price) || 0;
    const qty = Number(p.stock_quantity) || 0;
    return sum + price * qty;
  }, 0);

  $('#stat-count').textContent = String(count);
  $('#stat-value').textContent = formatMoney(value);

  const low = activeParts.filter(isLowStock);
  const list = $('#low-stock-list');
  const empty = $('#low-stock-empty');
  if (!list) return;
  
  list.innerHTML = '';

  if (low.length === 0) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
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

  // Features list
  const features = (p.features || '').split('\n').filter(f => f.trim() !== '');
  const featuresHtml = features.length > 0
    ? `<ul class="features-list">${features.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
    : '';

  // Colors
  const renderDots = (colors, type) => {
    if (!colors || colors.length === 0) return '';
    return `
      <div class="color-dots-row">
        <span class="color-dots-label">${type}:</span>
        ${colors.map(c => `<span class="color-dot ${String(c).toLowerCase()}" title="${escapeHtml(c)}"></span>`).join('')}
      </div>
    `;
  };

  const lensDots = renderDots(p.lens_colors, 'Lente');
  const ledDots = renderDots(p.led_colors, 'LED');

  card.innerHTML = `
    <div class="part-card__image-wrap">
      ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" class="part-card__image" loading="lazy">` : '<div class="part-card__image-placeholder"></div>'}
      <div class="part-card__badges">
        ${p.voltage ? `<span class="badge-spec"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> ${escapeHtml(p.voltage)}</span>` : ''}
        ${p.led_count ? `<span class="badge-spec">${escapeHtml(String(p.led_count))} LEDs</span>` : ''}
      </div>
    </div>
    <div class="part-card__content">
      <div class="part-card__header">
        <div class="part-number">${escapeHtml(String(p.part_number))}</div>
        <div class="price">${formatMoney(p.price)}</div>
      </div>
      <h3>${escapeHtml(String(p.name))}</h3>
      ${p.dimensions ? `<div class="dim-text"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2" ry="2"/></svg> ${escapeHtml(p.dimensions)}</div>` : ''}
      
      ${featuresHtml}

      <div class="color-dots-wrap">
        ${lensDots}
        ${ledDots}
      </div>

      <div class="${stockClass}">Stock: ${escapeHtml(String(p.stock_quantity ?? 0))}</div>
      <div class="meta">${escapeHtml(String(p.brand || '—'))} · ${escapeHtml(String(p.category || '—'))}</div>
    </div>
    
    ${showActions
      ? `<div class="part-card-actions" style="padding: 0 1.25rem 1.25rem;">
        <button type="button" class="btn btn-secondary btn-sm btn-edit" data-id="${escapeHtml(String(p.id))}">Editar</button>
        <button type="button" class="btn btn-danger btn-sm btn-delete" data-id="${escapeHtml(String(p.id))}">Eliminar</button>
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
  if (!grid) return;
  grid.innerHTML = '';

  const filtered = getFilteredParts('filter-q', 'filter-category', 'filter-brand');

  if (filtered.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  filtered.forEach((p) => grid.appendChild(buildPartCard(p, { showActions: false })));
}

function renderAdminCatalog() {
  const grid = $('#admin-catalog-grid');
  const empty = $('#admin-catalog-empty');
  if (!grid) return;
  grid.innerHTML = '';

  const filtered = getFilteredParts('admin-filter-q', 'admin-filter-category', '');

  if (filtered.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  filtered.forEach((p) => grid.appendChild(buildPartCard(p, { showActions: true })));
}

function populateBrandFilter() {
  const selPublic = $('#filter-brand');
  const brands = [...new Set(allParts.map((p) => p.brand).filter(Boolean))].sort((a, b) =>
    String(a).localeCompare(String(b), 'es')
  );

  const populate = (el) => {
    if (!el) return;
    const current = el.value;
    el.innerHTML = '<option value="">Todas</option>';
    brands.forEach((b) => {
      const opt = document.createElement('option');
      opt.value = String(b);
      opt.textContent = String(b);
      el.appendChild(opt);
    });
    el.value = brands.includes(current) ? current : '';
  };

  populate(selPublic);
}

function populateAdminCategoryFilter() {
  const sel = $('#admin-filter-category');
  if (!sel) return;
  const cats = [...new Set(allParts.map((p) => p.category).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Todas</option>';
  cats.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  });
}

function populateTransactionPartSelect() {
  const sel = $('#tx-part');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">— Selecciona un repuesto —</option>';
  
  // Para ventas nuevas, solo mostrar activos. 
  // Para edición, incluir el producto actual aunque esté inactivo.
  const activeAndCurrent = allParts.filter(p => p.is_active !== false || p.id === current);
  
  activeAndCurrent.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = String(p.id);
    opt.textContent = `${p.part_number} — ${p.name} (stock: ${p.stock_quantity})`;
    sel.appendChild(opt);
  });
  sel.value = activeAndCurrent.some(p => p.id === current) ? current : '';
}

function updateTxPartHint() {
  const id = $('#tx-part')?.value;
  const qty = $('#tx-qty');
  const ivaPercent = $('#tx-iva-percent');
  const total = $('#tx-total');
  const hint = $('#tx-stock-hint');

  if (!id) {
    if (hint) hint.textContent = '';
    return;
  }

  const p = allParts.find((x) => x.id === id);
  if (!p) return;

  const stock = Number(p.stock_quantity) || 0;
  if (hint) hint.textContent = `Stock: ${stock}`;

  // Auto-calculate if not in edit mode or if manually triggered
  const quantity = parseInt(qty.value, 10) || 1;
  const price = Number(p.price) || 0;
  const subtotal = price * quantity;
  const ivaVal = subtotal * ((Number(ivaPercent?.value) || 0) / 100);

  // Set total tentatively if not edited manually (simplified logic)
  if (total && !total.dataset.manual) {
    total.value = (subtotal + ivaVal).toFixed(2);
  }
}

function renderTransactionsTable() {
  const tbody = $('#transactions-tbody');
  const empty = $('#transactions-empty');
  const table = $('#transactions-table');
  if (!tbody) return;

  tbody.innerHTML = '';

  const start = $('#tx-filter-start')?.value;
  const end = $('#tx-filter-end')?.value;

  const filtered = allTransactions.filter(tx => {
    const d = tx.created_at.split('T')[0];
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });

  if (filtered.length === 0) {
    empty.hidden = false;
    table.hidden = true;
    return;
  }

  empty.hidden = true;
  table.hidden = false;

  const fmtDate = (iso) => new Date(iso).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });

  for (const tx of filtered) {
    const part = allParts.find((p) => p.id === tx.part_id);
    const pn = part ? part.part_number : '—';
    const nm = part ? part.name : '(repuesto no cargado)';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(fmtDate(tx.created_at))}</td>
      <td style="font-size:0.75rem; font-weight:700;">${escapeHtml(pn)}</td>
      <td>${escapeHtml(nm)}</td>
      <td class="num">${tx.quantity}</td>
      <td class="num">${formatMoney(tx.iva || 0)}</td>
      <td style="font-size:0.7rem; color:var(--ink-muted); max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(tx.notes || '')}">
        ${escapeHtml(tx.notes || '—')}
      </td>
      <td class="num" style="font-weight:800;">${formatMoney(tx.total)}</td>
      <td>
        <button class="btn btn-ghost btn-sm btn-edit-tx" data-id="${tx.id}">✏️</button>
      </td>
    `;
    tr.querySelector('.btn-edit-tx').onclick = () => startEditTx(tx);
    tbody.appendChild(tr);
  }
}

function startEditTx(tx) {
  const p = allParts.find(x => x.id === tx.part_id);
  const subtotal = p ? (Number(p.price) || 0) * tx.quantity : 0;
  const percentage = subtotal > 0 ? Math.round((tx.iva / subtotal) * 100) : 0;

  $('#tx-edit-id').value = tx.id;
  $('#tx-part').value = tx.part_id;
  $('#tx-qty').value = tx.quantity;
  $('#tx-iva-percent').value = percentage;
  $('#tx-total').value = tx.total;
  $('#tx-notes').value = tx.notes || '';

  $('#tx-submit').textContent = 'Guardar Cambios';
  $('#tx-cancel-edit').hidden = false;

  goToAdminSection('transactions');
  window.scrollTo({ top: $('#transaction-form').offsetTop - 100, behavior: 'smooth' });
}

function cancelEditTx() {
  $('#transaction-form').reset();
  $('#tx-edit-id').value = '';
  $('#tx-iva-percent').value = '15';
  $('#tx-submit').textContent = 'Registrar Venta';
  $('#tx-cancel-edit').hidden = true;
  delete $('#tx-total').dataset.manual;
  updateTxPartHint();
}

// ——— Multi-item Cart Functions ———

function renderCartUI() {
  const container = $('#tx-cart-container');
  const tbody = $('#tx-cart-body');
  const grandTotalEl = $('#tx-cart-grand-total');
  
  if (!container || !tbody || !grandTotalEl) return;
  
  if (currentSaleCart.length === 0) {
    container.hidden = true;
    tbody.innerHTML = '';
    grandTotalEl.textContent = '—';
    return;
  }
  
  container.hidden = false;
  tbody.innerHTML = '';
  let grandTotal = 0;
  
  currentSaleCart.forEach((item, idx) => {
    grandTotal += item.total;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(item.part_number)}</strong> — ${escapeHtml(item.name)}</td>
      <td>${item.quantity}</td>
      <td>${formatMoney(item.iva)}</td>
      <td style="font-weight:700;">${formatMoney(item.total)}</td>
      <td>
        <button type="button" class="btn-remove-cart" data-idx="${idx}">×</button>
      </td>
    `;
    tr.querySelector('.btn-remove-cart').onclick = () => removeFromCart(idx);
    tbody.appendChild(tr);
  });
  
  grandTotalEl.textContent = formatMoney(grandTotal);
}

function addToCart() {
  const partId = $('#tx-part').value;
  const qty = parseInt($('#tx-qty').value, 10) || 0;
  const percent = Number($('#tx-iva-percent').value) || 0;
  const total = Number($('#tx-total').value) || 0;
  
  if (!partId) {
    showToast('Selecciona un repuesto.', 'error');
    return;
  }
  if (qty < 1) {
    showToast('La cantidad debe ser al menos 1.', 'error');
    return;
  }
  
  const part = allParts.find(p => p.id === partId);
  if (!part) return;
  
  // Calculate IVA for this specific item
  const subtotal = (Number(part.price) || 0) * qty;
  const iva = subtotal * (percent / 100);
  
  currentSaleCart.push({
    part_id: partId,
    part_number: part.part_number,
    name: part.name,
    quantity: qty,
    iva: iva,
    total: total
  });
  
  // Reset item inputs
  $('#tx-part').value = '';
  $('#tx-qty').value = '1';
  $('#tx-total').value = '';
  delete $('#tx-total').dataset.manual;
  $('#tx-stock-hint').textContent = '';
  
  renderCartUI();
  showToast('Producto añadido al pedido.');
}

function removeFromCart(idx) {
  currentSaleCart.splice(idx, 1);
  renderCartUI();
}

function getFilteredParts(qId, catId, brandId) {
  const q = qId ? ($('#' + qId)?.value || '').trim().toLowerCase() : '';
  const cat = catId ? $('#' + catId)?.value : '';
  const brand = brandId ? $('#' + brandId)?.value : '';

  return allParts.filter((p) => {
    if (p.is_active === false) return false;
    if (cat && String(p.category || '') !== cat) return false;
    if (brand && String(p.brand || '') !== brand) return false;
    if (!q) return true;
    const name = String(p.name || '').toLowerCase();
    const pn = String(p.part_number || '').toLowerCase();
    const br = String(p.brand || '').toLowerCase();
    return name.includes(q) || pn.includes(q) || br.includes(q);
  });
}

function resetForm() {
  $('#part-form').reset();
  $('#field-id').value = '';
  $('#field-stock_quantity').value = '0';
  $('#field-low_stock_threshold').value = '5';
  $('#field-image_url').value = '';
  $('#image-preview-container').hidden = true;
  $('#image-preview').src = '';
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

  // New fields
  $('#field-dimensions').value = String(p.dimensions ?? '');
  $('#field-voltage').value = String(p.voltage ?? '');
  $('#field-led_count').value = p.led_count != null ? String(p.led_count) : '';
  $('#field-weight_ref').value = p.weight_ref != null ? String(p.weight_ref) : '';
  $('#field-features').value = String(p.features ?? '');
  $('#field-image_url').value = String(p.image_url ?? '');

  if (p.image_url) {
    $('#image-preview').src = p.image_url;
    $('#image-preview-container').hidden = false;
  } else {
    $('#image-preview-container').hidden = true;
  }

  // Checkboxes
  const setCheckboxes = (name, values) => {
    const boxes = $$(`input[name="${name}"]`);
    boxes.forEach(b => b.checked = (values || []).includes(b.value));
  };
  setCheckboxes('lens_colors', p.lens_colors);
  setCheckboxes('led_colors', p.led_colors);

  $('#form-title').textContent = 'Editar repuesto';
  $('#form-submit-btn').textContent = 'Actualizar';
  navigateTo('admin');
  goToAdminSection('form');
  $('#field-part_number').focus();
}

async function confirmDelete(p) {
  if (!supabase) return;
  const ok = window.confirm(
    `¿Eliminar el repuesto "${p.name}" (${p.part_number})? Esta acción no se puede deshacer.`
  );
  if (!ok) return;

  setGlobalLoading(true);
  try {
    const { error } = await supabase.from('parts').update({ is_active: false }).eq('id', p.id);
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

    // Technical fields
    const dimensions = $('#field-dimensions').value.trim() || null;
    const voltage = $('#field-voltage').value.trim() || null;
    const led_count = parseInt($('#field-led_count').value, 10) || null;
    const weight_ref = parseFloat($('#field-weight_ref').value) || null;
    const features = $('#field-features').value.trim() || null;
    let image_url = $('#field-image_url').value.trim() || null;

    const lens_colors = $$('input[name="lens_colors"]:checked').map(b => b.value);
    const led_colors = $$('input[name="led_colors"]:checked').map(b => b.value);

    setGlobalLoading(true);
    try {
      // 1. Handle Image Upload if needed
      const fileInput = $('#field-image');
      if (fileInput.files && fileInput.files[0]) {
        const file = fileInput.files[0];
        const fileExt = file.name.split('.').pop();
        const fileName = `${Math.random().toString(36).slice(2)}.${fileExt}`;
        const filePath = `parts/${fileName}`;

        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('parts-images')
          .upload(filePath, file);

        if (uploadError) {
          showToast(`Error al subir imagen: ${uploadError.message}`, 'error');
          return;
        }

        const { data: { publicUrl } } = supabase.storage
          .from('parts-images')
          .getPublicUrl(filePath);

        image_url = publicUrl;
      }

      // 2. Prepare Payload
      const payload = {
        part_number,
        name,
        category,
        brand,
        price,
        stock_quantity,
        low_stock_threshold,
        description,
        dimensions,
        voltage,
        led_count,
        weight_ref,
        features,
        lens_colors,
        led_colors,
        image_url,
      };

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

  // Image handling events
  $('#field-image').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        $('#image-preview').src = ev.target.result;
        $('#image-preview-container').hidden = false;
      };
      reader.readAsDataURL(file);
    }
  });

  $('#remove-image').addEventListener('click', () => {
    $('#field-image').value = '';
    $('#field-image_url').value = '';
    $('#image-preview-container').hidden = true;
    $('#image-preview').src = '';
  });

  $('#form-reset-btn').addEventListener('click', () => resetForm());

  $('#form-cancel-btn').addEventListener('click', () => {
    resetForm();
    goToAdminSection('catalog');
  });

  $$('.main-nav .nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.section));
  });

  $('#admin-open')?.addEventListener('click', () => navigateTo('admin'));
  $('#auth-close')?.addEventListener('click', () => showAuthModal(false));
  $('#auth-backdrop')?.addEventListener('click', () => showAuthModal(false));

  $$('.admin-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => goToAdminSection(btn.dataset.adminSection));
  });

  const logoutAction = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    hideAdminWorkspace();
    navigateTo('dashboard');
    showToast('Sesión cerrada.');
  };

  $('#admin-logout')?.addEventListener('click', logoutAction);
  $('#admin-logout-nav')?.addEventListener('click', logoutAction);

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

  $('#toggle-to-login')?.addEventListener('click', () => showAdminLoginForm());
  $('#toggle-to-setup')?.addEventListener('click', () => showAdminSetupForm());


  $('#brand-link').addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('catalog');
  });

  $('#filter-q').addEventListener('input', () => renderCatalog());
  $('#filter-category').addEventListener('change', () => renderCatalog());
  $('#filter-brand').addEventListener('change', () => renderCatalog());

  $('#admin-filter-q')?.addEventListener('input', () => renderAdminCatalog());
  $('#admin-filter-category')?.addEventListener('change', () => renderAdminCatalog());

  $('#tx-part').addEventListener('change', () => updateTxPartHint());
  $('#tx-qty').addEventListener('input', () => updateTxPartHint());
  $('#tx-iva-percent').addEventListener('input', () => updateTxPartHint());
  $('#tx-total').addEventListener('input', () => {
    $('#tx-total').dataset.manual = 'true';
  });

  $('#tx-filter-start')?.addEventListener('change', () => renderTransactionsTable());
  $('#tx-filter-end')?.addEventListener('change', () => renderTransactionsTable());
  $('#tx-cancel-edit')?.addEventListener('click', () => cancelEditTx());

  $('#tx-add-item').addEventListener('click', () => addToCart());

  $('#transaction-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!supabase) return;

    const txId = $('#tx-edit-id').value;
    const partId = $('#tx-part').value;
    const qty = parseInt($('#tx-qty').value, 10);
    const percent = Number($('#tx-iva-percent').value) || 0;
    const total = Number($('#tx-total').value) || 0;
    const notes = $('#tx-notes').value.trim() || null;

    setGlobalLoading(true);
    try {
      let res;
      if (txId) {
        // Modo Edición: Actualizar una sola transacción existente
        const part = allParts.find(p => p.id === partId);
        const subtotal = part ? (Number(part.price) || 0) * qty : 0;
        const ivaAmount = subtotal * (percent / 100);
        
        res = await supabase.rpc('update_transaction', {
          p_tx_id: txId,
          p_notes: notes,
          p_iva: ivaAmount,
          p_total: total
        });
      } else {
        // Modo Nueva Venta: Procesar Carrito
        if (currentSaleCart.length === 0) {
          if (partId && qty > 0) {
            addToCart(); // Auto-añadir lo que esté en pantalla
          } else {
            showToast('Añade al menos un producto al pedido.', 'error');
            setGlobalLoading(false);
            return;
          }
        }

        res = await supabase.rpc('create_multi_item_sale', {
          p_items: currentSaleCart,
          p_notes: notes
        });
      }

      const { data, error } = res;
      if (error) {
        showToast(`Error: ${error.message}`, 'error');
        return;
      }

      showToast(txId ? 'Registro actualizado correctamente.' : '¡Venta multiobjeto registrada con éxito!');
      
      // Reset completo
      currentSaleCart = [];
      renderCartUI();
      $('#transaction-form').reset();
      cancelEditTx();
      await refreshAllData();
    } catch (err) {
      console.error(err);
      showToast('Error inesperado al procesar la venta.', 'error');
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

  // Wire global event listeners (navigation, etc)
  wireEventListeners();
  initScrollDrivenMotion();

  // Initial data load
  await refreshAllData();

  // SPA routing
  window.addEventListener('hashchange', handleHash);
  handleHash();
}

bootstrap();
