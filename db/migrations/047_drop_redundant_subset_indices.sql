-- ============================================================
-- Migration 047: DROP indices redundantes (subset prefix overlap)
-- FIX-WORKER-18 pass 9: drop dead idx baseado em ANALISE ESTATICA segura.
-- ============================================================
-- METODOLOGIA:
--   W18 pass 8 criou tooling /aiops/db/dead-indexes (pg_stat_user_indexes audit)
--   MAS sem acesso prod stats, drop "as cegas" eh risco regressao.
--
--   Esta migration aplica DROPS BASEADOS EM ANALISE ESTATICA pura:
--   - Identifica indices SUBSET PREFIX (single-col coberto por composite N-col)
--   - PG planner pode usar idx composite (a,b) para query WHERE a=?
--     (B-tree ordering: prefix scan eficiente)
--   - Idx single-col redundante = storage waste + INSERT overhead
--
-- HISTORIA DROPS PREVIOS (idempotency check - se ja dropou, no-op):
--   mig 023: idx_notif_outbox_unlocked (redundant)
--   mig 029: idx_notif_user_unread (dead WHERE filter coverage)
--   mig 047 (esta): 2 subset prefix dropps
--
-- DEFER (precisa pg_stat real, nao analise estatica):
--   - idx_orders_status: broad mas usado em admin queue (Mvp keep)
--   - idx_pviews_created: usado em trending recent (W18 pass 7)
--   - Outros: requer W18 pass 8 audit em prod 2+ semanas
-- ============================================================

-- 1. DROP idx_pviews_user (mig 011:9)
-- Coberto por idx_pviews_user_recent (mig 011:13) = (user_id, created_at DESC)
-- PG planner usa composite prefix scan para queries WHERE user_id = ?
-- + Idx rolling (mig 041 idx_pviews_rolling_90d + 30d) tambem covers user_id
-- - Idx single-col user redundante storage + INSERT overhead.
DROP INDEX IF EXISTS idx_pviews_user;

COMMENT ON COLUMN product_views.user_id IS
  'FIX-W18-9: idx single-col dropado (mig 047). Coberto por idx_pviews_user_recent (mig 011) + idx_pviews_rolling_90d/30d (mig 041).';

-- 2. DROP idx_oi_product (mig 006:148)
-- Coberto por idx_oi_product_order_covering (mig 038:34) = (product_id, order_id)
-- PG planner usa composite prefix scan para queries WHERE product_id = ?
-- Composite COBRE single. Aproximadamente 50% menos storage.
DROP INDEX IF EXISTS idx_oi_product;

COMMENT ON COLUMN order_items.product_id IS
  'FIX-W18-9: idx single-col dropado (mig 047). Coberto por idx_oi_product_order_covering (mig 038).';

-- ============================================================
-- VALIDATION POS-APPLY:
--   EXPLAIN ANALYZE SELECT * FROM product_views WHERE user_id = '<uuid>'
--   - DEVE mostrar: "Index Only Scan using idx_pviews_user_recent"
--   - OR: "Bitmap Heap Scan + Bitmap Index Scan on idx_pviews_user_recent"
--   - NUNCA: "Seq Scan" (significaria que idx alternativo nao foi escolhido)
--
--   EXPLAIN ANALYZE SELECT * FROM order_items WHERE product_id = '<uuid>'
--   - DEVE mostrar: idx_oi_product_order_covering scan
--
-- ROLLBACK PLAN (se EXPLAIN ANALYZE mostrar Seq Scan):
--   CREATE INDEX IF NOT EXISTS idx_pviews_user
--     ON product_views(user_id) WHERE user_id IS NOT NULL;
--   CREATE INDEX IF NOT EXISTS idx_oi_product
--     ON order_items(product_id);
-- ============================================================

-- ANALYZE p/ atualizar pg_statistics + ajudar planner escolher idx novo
ANALYZE product_views;
ANALYZE order_items;
