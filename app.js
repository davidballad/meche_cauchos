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
    minimumFractionDigits: 2,
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
    search: '#search-loading',
    transactions: '#transactions-loading',
  };
  const sel = map[sectionId];
  if (!sel) return;
  const el = $(sel);
  el.hidden = !on;
}

function clearAllLoadingUI() {
  setGlobalLoading(false);
  setSectionLoading('dashboard', false);
  setSectionLoading('catalog', false);
  setSectionLoading('search', false);
  setSectionLoading('transactions', false);
}

function showSection(id) {
  $$('.section').forEach((s) => s.classList.toggle('active', s.id === `section-${id}`));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === id));
  if (id === 'search') renderSearchResults();
  if (id === 'transactions') {
    populateTransactionPartSelect();
    renderTransactionsTable();
    updateTxPartHint();
  }
}

function navigateTo(section) {
  showSection(section);
  if (section === 'dashboard') renderDashboard();
  if (section === 'catalog') renderCatalog();
}

async function refreshAllData() {
  if (!supabase) {
    clearAllLoadingUI();
    return;
  }

  setGlobalLoading(true);
  setSectionLoading('dashboard', true);
  setSectionLoading('catalog', true);
  setSectionLoading('search', true);
  setSectionLoading('transactions', true);

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
            `Transacciones no disponibles: ${txError.message}. Si acabas de actualizar la app, ejecuta supabase_migration_transactions.sql en el SQL Editor de Supabase.`,
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
    allTransactions = txRows;

    renderDashboard();
    renderCatalog();
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
  allParts.forEach((p) => grid.appendChild(buildPartCard(p)));
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
  const id = $('#tx-part').value;
  const qty = $('#tx-qty');
  const hint = $('#tx-stock-hint');
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
  filtered.forEach((p) => grid.appendChild(buildPartCard(p)));
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
  navigateTo('form');
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
      navigateTo('catalog');
    } finally {
      setGlobalLoading(false);
    }
  });

  $('#form-reset-btn').addEventListener('click', () => resetForm());

  $$('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.section));
  });

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
      navigateTo('transactions');
    } catch (err) {
      console.error(err);
      showToast(err instanceof Error ? err.message : 'Error al registrar la transacción.', 'error');
    } finally {
      setGlobalLoading(false);
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
  wireEventListeners();
  await refreshAllData();
}

bootstrap();
