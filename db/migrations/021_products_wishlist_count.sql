-- Migration 021: products.wishlist_count denormalized counter (WORKER 14)
-- =====================================================================
-- PROBLEMA:
-- Para exibir "Favoritado por 1.2k pessoas" no PDP (signal de social proof
-- estilo Mercado Livre), seria preciso COUNT(*) FROM product_wishlist
-- WHERE product_id = $1 a cada request -> ainda que index-backed eh
-- 1 query extra por PDP load.
--
-- SOLUCAO:
-- Coluna denormalizada products.wishlist_count + trigger AFTER INSERT/DELETE
-- em product_wishlist mantem em sync. PDP le do products diretamente.
-- =====================================================================

DO $$ BEGIN
  ALTER TABLE products ADD COLUMN IF NOT EXISTS wishlist_count INTEGER NOT NULL DEFAULT 0;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- Backfill counts existentes
DO $$ BEGIN
  UPDATE products p
     SET wishlist_count = COALESCE((
       SELECT COUNT(*)::INTEGER FROM product_wishlist w WHERE w.product_id = p.id
     ), 0);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- Trigger sync: INSERT em wishlist -> +1
CREATE OR REPLACE FUNCTION fn_wishlist_count_inc() RETURNS TRIGGER AS $$
BEGIN
  UPDATE products SET wishlist_count = wishlist_count + 1 WHERE id = NEW.product_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger sync: DELETE em wishlist -> -1 (GREATEST anti-negative)
CREATE OR REPLACE FUNCTION fn_wishlist_count_dec() RETURNS TRIGGER AS $$
BEGIN
  UPDATE products SET wishlist_count = GREATEST(0, wishlist_count - 1) WHERE id = OLD.product_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  DROP TRIGGER IF EXISTS tr_wishlist_count_inc ON product_wishlist;
  CREATE TRIGGER tr_wishlist_count_inc AFTER INSERT ON product_wishlist
    FOR EACH ROW EXECUTE FUNCTION fn_wishlist_count_inc();
EXCEPTION WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  DROP TRIGGER IF EXISTS tr_wishlist_count_dec ON product_wishlist;
  CREATE TRIGGER tr_wishlist_count_dec AFTER DELETE ON product_wishlist
    FOR EACH ROW EXECUTE FUNCTION fn_wishlist_count_dec();
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- Index para ORDER BY wishlist_count (sort por popularidade)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_products_wishlist ON products(wishlist_count DESC)
    WHERE status = 'approved' AND deleted_at IS NULL AND wishlist_count > 0;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
