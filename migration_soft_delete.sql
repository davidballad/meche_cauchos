-- migration_soft_delete.sql
-- Ejecutar en Supabase → SQL Editor

-- 1. Añadir columna is_active a la tabla de repuestos
ALTER TABLE public.parts ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- 2. Asegurar que los productos existentes tengan el valor true
UPDATE public.parts SET is_active = true WHERE is_active IS NULL;
