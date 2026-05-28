-- Migration 075: composite idx product_wishlist(user_id, created_at DESC)
-- W14 pass 252 - 2026-05-28
--
-- CONTEXTO:
-- product_wishlist PK = (user_id, product_id) - bom p/ lookup point.
-- Hot path /conta/favoritos:
--   SELECT ... FROM product_wishlist w JOIN products p
--    WHERE w.user_id = $1
--    ORDER BY w.created_at DESC, w.product_id ASC
--    LIMIT 20 OFFSET 0
--
-- INDICES EXISTENTES:
--   PK (user_id, product_id)         - lookup point
--   idx_wishlist_product (product_id)- reverse lookup (counts)
--   idx_wishlist_user (user_id)      - redundante com PK
--
-- PROBLEMA:
-- PK cobre user_id filter mas ordena por product_id (PK order), NAO created_at.
-- PG precisa Sort step in-memory para ORDER BY created_at DESC.
-- User power buyer com 500 favoritos: sort 500 rows ~10-30ms per /favoritos hit.
-- Cache 60s cobre miss cycle mas refresh agressivo (mobile pull-to-refresh) hit it.
--
-- POST-FIX: composite idx (user_id, created_at DESC) PARTIAL nao necessario
-- (todas rows sao "favoritados ativos" - sem soft-delete column).
-- Index covers WHERE + ORDER BY em 1 scan.
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_wishlist_user_created;

CREATE INDEX IF NOT EXISTS idx_wishlist_user_created
  ON product_wishlist(user_id, created_at DESC);

DO $$
BEGIN
  RAISE NOTICE 'W14-pass252: idx_wishlist_user_created created';
END $$;
