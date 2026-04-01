-- MZ Cauchos & Accesorios: tabla de repuestos para el catálogo
-- Ejecutar en Supabase → SQL Editor → New query → Run

create table if not exists public.parts (
  id uuid primary key default gen_random_uuid(),
  part_number text not null unique,
  name text not null,
  category text,
  brand text,
  price numeric,
  stock_quantity integer not null default 0,
  low_stock_threshold integer not null default 5,
  description text,
  created_at timestamptz not null default now()
);

-- Índices útiles para búsqueda y filtros
create index if not exists parts_category_idx on public.parts (category);
create index if not exists parts_brand_idx on public.parts (brand);
create index if not exists parts_name_idx on public.parts (name);

-- Políticas RLS: lectura/escritura anónima (desarrollo). En producción ejecuta
-- supabase_migration_admin_auth.sql: catálogo solo lectura para el público y panel admin autenticado.
alter table public.parts enable row level security;

drop policy if exists "Permitir lectura pública de parts" on public.parts;
drop policy if exists "Permitir inserción pública de parts" on public.parts;
drop policy if exists "Permitir actualización pública de parts" on public.parts;
drop policy if exists "Permitir borrado público de parts" on public.parts;

create policy "Permitir lectura pública de parts"
  on public.parts for select
  to anon, authenticated
  using (true);

create policy "Permitir inserción pública de parts"
  on public.parts for insert
  to anon, authenticated
  with check (true);

create policy "Permitir actualización pública de parts"
  on public.parts for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "Permitir borrado público de parts"
  on public.parts for delete
  to anon, authenticated
  using (true);

-- ——— Transacciones (ventas / salidas de inventario) ———

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null references public.parts (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price numeric,
  total numeric,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists transactions_part_id_idx on public.transactions (part_id);
create index if not exists transactions_created_at_idx on public.transactions (created_at desc);

alter table public.transactions enable row level security;

drop policy if exists "Permitir lectura de transactions" on public.transactions;

create policy "Permitir lectura de transactions"
  on public.transactions for select
  to anon, authenticated
  using (true);

-- Inserción y descuento de stock solo vía función (evita carreras)
create or replace function public.create_transaction_sale (
  p_part_id uuid,
  p_quantity integer,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock integer;
  v_price numeric;
  v_tx_id uuid;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'Cantidad inválida';
  end if;

  select stock_quantity, coalesce(price, 0)
    into v_stock, v_price
  from public.parts
  where id = p_part_id
  for update;

  if not found then
    raise exception 'Repuesto no encontrado';
  end if;

  if v_stock < p_quantity then
    raise exception 'Stock insuficiente (disponible: %)', v_stock;
  end if;

  update public.parts
  set stock_quantity = stock_quantity - p_quantity
  where id = p_part_id;

  insert into public.transactions (part_id, quantity, unit_price, total, notes)
  values (p_part_id, p_quantity, v_price, v_price * p_quantity, p_notes)
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

grant execute on function public.create_transaction_sale (uuid, integer, text) to anon, authenticated;
