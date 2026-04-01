-- Migration: Add IVA and Editable Totals to Transactions
-- Ejecutar en Supabase → SQL Editor

-- 1. Añadir columna IVA a la tabla de transacciones
alter table public.transactions add column if not exists iva numeric default 0;

-- 2. Actualizar la función para permitir especificar IVA y Total manualmente
create or replace function public.create_transaction_sale (
  p_part_id uuid,
  p_quantity integer,
  p_notes text default null,
  p_iva numeric default null,
  p_total numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock integer;
  v_price numeric;
  v_calculated_iva numeric;
  v_calculated_total numeric;
  v_tx_id uuid;
begin
  -- Solo administradores pueden ejecutar (ya manejado por permisos de Grant pero por seguridad extra)
  if auth.uid() is distinct from (
    select admin_user_id from public.app_settings where singleton_key = 'default'
  ) then
    raise exception 'No autorizado';
  end if;

  if p_quantity is null or p_quantity < 1 then
    raise exception 'Cantidad inválida';
  end if;

  -- Bloquear fila del repuesto para actualización
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

  -- Calcular valores si no se proveen (ej: IVA 0% por defecto si es null)
  v_calculated_iva := coalesce(p_iva, 0);
  v_calculated_total := coalesce(p_total, (v_price * p_quantity) + v_calculated_iva);

  -- Actualizar stock
  update public.parts
  set stock_quantity = stock_quantity - p_quantity
  where id = p_part_id;

  -- Insertar transacción
  insert into public.transactions (part_id, quantity, unit_price, total, iva, notes)
  values (p_part_id, p_quantity, v_price, v_calculated_total, v_calculated_iva, p_notes)
  returning id into v_tx_id;

  return v_tx_id;
end;
$$;

-- 3. Nueva función para Editar Transacciones (solo Admin)
create or replace function public.update_transaction (
  p_tx_id uuid,
  p_notes text,
  p_iva numeric,
  p_total numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is distinct from (
    select admin_user_id from public.app_settings where singleton_key = 'default'
  ) then
    raise exception 'No autorizado';
  end if;

  update public.transactions
  set 
    notes = p_notes,
    iva = p_iva,
    total = p_total
  where id = p_tx_id;
end;
$$;

grant execute on function public.update_transaction (uuid, text, numeric, numeric) to authenticated;
