-- migration_multi_item.sql
-- Ejecutar en Supabase → SQL Editor

-- 1. Añadir columna sale_id para agrupar ítems si no existe
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS sale_id UUID;

-- 2. Función para crear ventas de múltiples ítems de forma atómica
CREATE OR REPLACE FUNCTION public.create_multi_item_sale (
  p_items JSONB, -- Formato: [{ "part_id": "uuid", "quantity": 1, "iva": 0.5, "total": 10.5 }]
  p_notes TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale_id UUID := gen_random_uuid();
  v_item JSONB;
  v_part_id UUID;
  v_stock INTEGER;
  v_qty INTEGER;
  v_iva NUMERIC;
  v_total NUMERIC;
  v_price NUMERIC;
BEGIN
  -- Verificar permisos (Solo admin)
  IF auth.uid() IS DISTINCT FROM (
    SELECT admin_user_id FROM public.app_settings WHERE singleton_key = 'default'
  ) THEN
    RAISE EXCEPTION 'No autorizado';
  END IF;

  -- Procesar cada ítem del JSON
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_part_id := (v_item->>'part_id')::UUID;
    v_qty := (v_item->>'quantity')::INTEGER;
    v_iva := (v_item->>'iva')::NUMERIC;
    v_total := (v_item->>'total')::NUMERIC;

    -- Validar stock y obtener precio actual para el registro histórico
    SELECT stock_quantity, coalesce(price, 0)
      INTO v_stock, v_price
    FROM public.parts
    WHERE id = v_part_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Repuesto con ID % no encontrado', v_part_id;
    END IF;

    IF v_stock < v_qty THEN
      RAISE EXCEPTION 'Stock insuficiente para el producto (Disponible: %)', v_stock;
    END IF;

    -- Actualizar stock
    UPDATE public.parts
    SET stock_quantity = stock_quantity - v_qty
    WHERE id = v_part_id;

    -- Insertar ítem de la transacción
    INSERT INTO public.transactions (sale_id, part_id, quantity, unit_price, total, iva, notes)
    VALUES (v_sale_id, v_part_id, v_qty, v_price, v_total, v_iva, p_notes);
  END LOOP;

  RETURN json_build_object('sale_id', v_sale_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_multi_item_sale (JSONB, TEXT) TO authenticated;
