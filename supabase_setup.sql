-- MZCauchos: tabla de repuestos para el catálogo
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

-- Políticas RLS: en el tier gratuito, habilita RLS y permite lectura/escritura anónima
-- Ajusta según tu modelo de seguridad (por ejemplo, solo service role o auth).
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
