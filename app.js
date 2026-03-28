import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm';

/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let supabase = null;

/** @type {Array<Record<string, unknown>>} */
let allParts = [];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function formatMoney(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return '—';
  return new Intl.NumberFormat('es', {
    style: 'currency',
    currency: 'EUR',
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
}

function showSection(id) {
  $$('.section').forEach((s) => s.classList.toggle('active', s.id === `section-${id}`));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === id));
  if (id === 'search') renderSearchResults();
}

function navigateTo(section) {
  showSection(section);
  if (section === 'dashboard') renderDashboard();
  if (section === 'catalog') renderCatalog();
}

async function fetchAllParts() {
  if (!supabase) {
    clearAllLoadingUI();
    return;
  }

  setGlobalLoading(true);
  setSectionLoading('dashboard', true);
  setSectionLoading('catalog', true);
  setSectionLoading('search', true);

  try {
    const { data, error } = await supabase
      .from('parts')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.error(error);
      showToast(`Error al cargar datos: ${error.message}`, 'error');
      allParts = [];
      return;
    }
    allParts = data || [];
    renderDashboard();
    renderCatalog();
    populateBrandFilter();
    renderSearchResults();
  } catch (err) {
    console.error(err);
    showToast(`Error al cargar datos: ${err instanceof Error ? err.message : String(err)}`, 'error');
    allParts = [];
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
    await fetchAllParts();
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
      await fetchAllParts();
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
  await fetchAllParts();
}

bootstrap();
