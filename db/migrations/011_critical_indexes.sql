-- Migration 011: Indices criticos faltantes (WORKER 14 DB SCHEMA audit)
-- Auditoria identificou 25 FKs sem indice + hotpaths sem suporte.
-- Esta migration adiciona os 14 indices mais impactantes para queries quentes.
-- Tolerante a falhas: CREATE INDEX IF NOT EXISTS.
-- CONCURRENTLY removido pois nao funciona em transacao - migration roda dentro de tx.

BEGIN;

-- =====================================================================
-- 1) MLB-6 Recomendacoes: product_views JOIN por user_id + (user_id, created_at)
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_pviews_user           ON product_views(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pviews_user_recent    ON product_views(user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- =====================================================================
-- 2) MLB-4 Loyalty: ORDER BY created_at DESC em /loyalty/me historico
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_loyalty_user_recent   ON loyalty_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_tier          ON user_loyalty(tier);

-- =====================================================================
-- 3) Q&A PDP: filtra por asked_by_user_id (ja tem product, falta autor)
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_qna_asked_by          ON product_qna(asked_by_user_id);
CREATE INDEX IF NOT EXISTS idx_qna_answered_by       ON product_qna(answered_by_user_id) WHERE answered_by_user_id IS NOT NULL;

-- =====================================================================
-- 4) Wishlist: lookup por user (sem indice em product_id+user_id combinada nem em wishlists.user_id alone se nao ha PK composta)
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_wishlists_user        ON wishlists(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_product     ON wishlists(product_id);

-- =====================================================================
-- 5) Auth/Security: token_blacklist e fail2ban lookups por user
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_token_blacklist_user  ON token_blacklist(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fail2ban_user         ON fail2ban_log(user_id) WHERE user_id IS NOT NULL;

-- =====================================================================
-- 6) Payments: webhook lookups + splits FK
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_asaas_webhook_order   ON asaas_webhook_events(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asaas_splits_order_item ON asaas_splits(order_item_id) WHERE order_item_id IS NOT NULL;

-- =====================================================================
-- 7) Coupon uses: lookup por order (validacao de cupom unico/pedido)
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_coupon_uses_order     ON coupon_uses(order_id);

-- =====================================================================
-- 8) Disputes (futuro): mediator e opener
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_disputes_mediator     ON disputes(mediator_user_id) WHERE mediator_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_disputes_opener       ON disputes(opened_by_user_id);

-- =====================================================================
-- 9) Search log: anal. cliques (futuro AIOps)
-- =====================================================================
CREATE INDEX IF NOT EXISTS idx_search_log_clicked    ON search_log(clicked_product_id) WHERE clicked_product_id IS NOT NULL;

-- registro da migration
INSERT INTO schema_migrations (version, applied_at)
VALUES ('011_critical_indexes', NOW())
ON CONFLICT (version) DO NOTHING;

COMMIT;

-- Para invalidar planner cache (opcional, sem efeito em tx)
ANALYZE product_views;
ANALYZE loyalty_transactions;
ANALYZE product_qna;
ANALYZE wishlists;
ANALYZE asaas_webhook_events;
ANALYZE coupon_uses;
