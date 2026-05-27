-- ============================================================
-- Migration 039: products.max_downloads col + sellers.default_max_downloads
-- FIX-WORKER-14 pass 1: gap doc W7 pass 20 - permite override do
-- DEFAULT_DOWNLOAD_LIMIT (50) por produto + default per-seller.
-- ============================================================
-- CONTEXTO:
--   W7 pass 20 introduziu cap download_count = 50 (hardcoded constant).
--   Politica de negocio:
--   - Produto pesado (modelo IA 50GB) -> 5 downloads/lifetime suficiente
--   - Produto leve (prompt pack 100KB) -> 100 downloads tolerable
--   - Seller premium -> default mais generoso (UX)
--   - Produto digital simples -> 50 default
--
--   Override hierarchy (mais especifico vence):
--   1. products.max_downloads (NULL = usa seller default)
--   2. sellers.default_max_downloads (NULL = usa platform default)
--   3. DEFAULT_DOWNLOAD_LIMIT = 50 (download.js constant)
--
-- ============================================================

-- 1. products.max_downloads (override per-product)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS max_downloads INT;

-- Constraint defensiva: 0 nao faz sentido (revenue immediate-zero),
-- negativo bug. NULL = inherit seller default (semantica).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_products_max_downloads_positive'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT chk_products_max_downloads_positive
      CHECK (max_downloads IS NULL OR max_downloads > 0);
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL; -- constraint ja existe, tolerante a re-aplicacao
END $$;

COMMENT ON COLUMN products.max_downloads IS
  'FIX-W14: override download cap. NULL=seller default, INT>0=cap especifico. Pattern W7 Regra L.';

-- 2. sellers.default_max_downloads (default per-seller plan)
-- Seller premium (gold+) pode setar 100, starter mantem 50.
-- NULL = inherit platform DEFAULT_DOWNLOAD_LIMIT.
ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS default_max_downloads INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_sellers_default_max_downloads_positive'
  ) THEN
    ALTER TABLE sellers
      ADD CONSTRAINT chk_sellers_default_max_downloads_positive
      CHECK (default_max_downloads IS NULL OR default_max_downloads > 0);
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

COMMENT ON COLUMN sellers.default_max_downloads IS
  'FIX-W14: seller-level default download cap. Aplicado a produtos sem override. NULL=platform default.';

-- 3. Backfill OPCIONAL: produtos com price > R$ 500 sao caros -> cap menor 20
-- Política conservadora: produtos premium R$500+ default 20 downloads
-- (sufficient HD swap + multi-device mas anti-distribuicao alto-valor)
-- NAO sobrescreve overrides manuais (so WHERE max_downloads IS NULL)
-- Comentado por padrao - admin decide aplicar OU nao.

-- UPDATE products SET max_downloads = 20
--  WHERE max_downloads IS NULL AND price_cents > 50000
--    AND deleted_at IS NULL AND status IN ('approved','platform_owned');

-- 4. IDX p/ queries futuras (admin dashboard "produtos com cap custom")
CREATE INDEX IF NOT EXISTS idx_products_max_downloads_set
  ON products(max_downloads)
  WHERE max_downloads IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX idx_products_max_downloads_set IS
  'FIX-W14: partial idx p/ admin listar produtos com cap custom (excludes default NULL).';
