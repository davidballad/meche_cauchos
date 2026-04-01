-- Administración: un solo usuario, catálogo público de solo lectura.
-- Ejecutar en Supabase → SQL Editor después de supabase_setup.sql (o migraciones previas).

-- ——— Configuración global (una fila) ———
create table if not exists public.app_settings (
  singleton_key text primary key default 'default',
  admin_user_id uuid references auth.users (id) on delete set null,
  admin_initialized boolean not null default false
);

insert into public.app_settings (singleton_key, admin_initialized)
values ('default', false)
on conflict (singleton_key) do nothing;

alter table public.app_settings enable row level security;

drop policy if exists "Lectura app_settings" on public.app_settings;
create policy "Lectura app_settings"
  on public.app_settings for select
  to anon, authenticated
  using (true);

-- Solo las funciones SECURITY DEFINER modifican esta tabla.

-- ——— Quitar escritura anónima en parts ———
drop policy if exists "Permitir inserción pública de parts" on public.parts;
drop policy if exists "Permitir actualización pública de parts" on public.parts;
drop policy if exists "Permitir borrado público de parts" on public.parts;

create policy "parts_insert solo admin"
  on public.parts for insert
  to authenticated
  with check (
    auth.uid() = (
      select admin_user_id from public.app_settings where singleton_key = 'default'
    )
  );

create policy "parts_update solo admin"
  on public.parts for update
  to authenticated
  using (
    auth.uid() = (
      select admin_user_id from public.app_settings where singleton_key = 'default'
    )
  )
  with check (
    auth.uid() = (
      select admin_user_id from public.app_settings where singleton_key = 'default'
    )
  );

create policy "parts_delete solo admin"
  on public.parts for delete
  to authenticated
  using (
    auth.uid() = (
      select admin_user_id from public.app_settings where singleton_key = 'default'
    )
  );

-- ——— Transacciones: lectura e inserción solo admin (vía RPC) ———
drop policy if exists "Permitir lectura de transactions" on public.transactions;

create policy "transactions_select solo admin"
  on public.transactions for select
  to authenticated
  using (
    auth.uid() = (
      select admin_user_id from public.app_settings where singleton_key = 'default'
    )
  );

-- ——— Registro del primer (y único) administrador ———
create or replace function public.claim_admin_slot ()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid;
begin
  select admin_user_id into v_admin
  from public.app_settings
  where singleton_key = 'default'
  for update;

  if v_admin is null then
    update public.app_settings
    set
      admin_user_id = auth.uid(),
      admin_initialized = true
    where singleton_key = 'default';
    return jsonb_build_object('ok', true, 'new', true);
  end if;

  if v_admin = auth.uid() then
    return jsonb_build_object('ok', true, 'new', false);
  end if;

  raise exception 'Solo existe una cuenta de administración.';
end;
$$;

grant execute on function public.claim_admin_slot () to authenticated;

revoke execute on function public.create_transaction_sale (uuid, integer, text) from anon;
grant execute on function public.create_transaction_sale (uuid, integer, text) to authenticated;

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
  if auth.uid() is distinct from (
    select admin_user_id from public.app_settings where singleton_key = 'default'
  ) then
    raise exception 'No autorizado';
  end if;

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
