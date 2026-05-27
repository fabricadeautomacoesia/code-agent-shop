-- ============================================================
-- Migration 038: indices estrategicos p/ CTE co_buyers em /also-bought (MLB-13)
-- FIX-WORKER-18 pass 6: acelera collaborative filtering W7 pass 10.
-- ============================================================
-- CONTEXTO:
--   /also-bought (W7 pass 10) usa CTE co_buyers:
--     SELECT DISTINCT o.buyer_user_id
--       FROM order_items oi
--       JOIN orders o ON o.id = oi.order_id
--      WHERE oi.product_id = $1
--        AND o.status IN ('paid','fulfilled')
--        AND o.buyer_user_id IS NOT NULL
--
--   Plano sem idx partial:
--   1. idx_oi_product scan product_id=$1 -> N order_items rows
--   2. PK orders fetch via order_id -> N heap fetches (random IO)
--   3. Filter status IN (...) -> M rows (M < N, ~30-50% paid+fulfilled)
--   4. Filter buyer_user_id NOT NULL (~99% rows tem)
--   5. DISTINCT buyer_user_id
--
--   Plano com idx partial:
--   1. idx_oi_product (product_id, order_id) covering -> index-only scan
--   2. idx_orders_paid (id, buyer_user_id) WHERE status IN (...)
--      -> index-only scan, ja filtrado, ja com buyer
--   3. DISTINCT (sem heap fetch)
--
--   Beneficio esperado:
--   - 50k orders + 200k order_items: ~50-200ms -> ~5-20ms (~10x)
--   - 1M orders (escala MLB futuro): ~2-10s -> ~50-200ms (~50x)
--   - Idx parcial reduz tamanho ~70% (cancelled/pending/failed excluidos)
--
-- ============================================================

-- 1. IDX PARCIAL orders WHERE status IN ('paid','fulfilled')
-- Cobre buyer_user_id no leaf -> index-only scan para CTE co_buyers JOIN
-- WHERE clause partial reduz idx ~30% do tamanho full (so paid+fulfilled)
-- Status broader idx_orders_status (mig 006:97) cobre fluxo admin/seller dash.
-- Este idx eh DEDICADO a queries de recomendacao collaborative.
CREATE INDEX IF NOT EXISTS idx_orders_paid_fulfilled_buyer
  ON orders(id, buyer_user_id)
  WHERE status IN ('paid','fulfilled') AND buyer_user_id IS NOT NULL;

-- 2. COVERING IDX order_items (product_id, order_id)
-- Permite index-only scan p/ CTE inicial (oi.product_id=$1 JOIN orders.id=oi.order_id)
-- Atualmente idx_oi_product (mig 006:148) so cobre product_id -> heap fetch para order_id.
-- Este covering inclui order_id no leaf -> scan completo sem heap.
-- Nota: NAO substitui idx_oi_product (single-col ainda otimo p/ outros queries).
-- IF NOT EXISTS protege contra re-aplicacao.
CREATE INDEX IF NOT EXISTS idx_oi_product_order_covering
  ON order_items(product_id, order_id);

-- 3. BONUS: idx parcial product_views WHERE created_at > 90d
--    /recommendations/for-me CTE viewed (W7 pass 8) filtra > 90d em product_views.
--    Idx existente product_views(user_id) faz seq scan filtrando created_at apos fetch.
--    Partial idx so com rows recentes acelera CTE muito.
--    NAO INCLUIDO: created_at > NOW() - INTERVAL deterministico (IMMUTABLE) nao
--    funciona em CREATE INDEX (postgres requer expressao imutavel). Solucao real
--    requer cron periodico DROP+CREATE com data dinamica - merece iter dedicada W18 pass 7.

-- ============================================================
-- VALIDACAO POS-APPLY:
--   EXPLAIN ANALYZE
--     WITH co_buyers AS (...) -- original /also-bought query
--   Deve mostrar:
--     - "Index Only Scan using idx_oi_product_order_covering"
--     - "Index Only Scan using idx_orders_paid_fulfilled_buyer"
--     - Total runtime drasticamente menor
-- ============================================================

COMMENT ON INDEX idx_orders_paid_fulfilled_buyer IS
  'FIX-W18 pass 6: parcial paid+fulfilled p/ collaborative filtering CTE co_buyers (also-bought).';
COMMENT ON INDEX idx_oi_product_order_covering IS
  'FIX-W18 pass 6: covering (product_id, order_id) p/ index-only scan CTE co_buyers JOIN.';
