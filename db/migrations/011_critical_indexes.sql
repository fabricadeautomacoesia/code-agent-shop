-- Migration 011: Indices criticos faltantes (WORKER 14 DB SCHEMA audit)
-- Cada CREATE INDEX dentro de bloco DO para tolerar tabela ausente sem abortar.
-- Auditoria identificou 25 FKs sem indice + hotpaths sem suporte.

-- =====================================================================
-- 1) MLB-6 Recomendacoes: product_views por user_id
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_pviews_user        ON product_views(user_id) WHERE user_id IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_pviews_user_recent ON product_views(user_id, created_at DESC) WHERE user_id IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 2) MLB-4 Loyalty: historico ORDER BY DESC
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_loyalty_user_recent ON loyalty_transactions(user_id, created_at DESC);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_loyalty_tier        ON user_loyalty(tier);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 3) Q&A PDP: filtro por autor (asked_by) + answered_by
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_qna_asked_by    ON product_qna(asked_by_user_id);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_qna_answered_by ON product_qna(answered_by_user_id) WHERE answered_by_user_id IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 4) Wishlist (tabela real product_wishlist)
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_wishlist_user    ON product_wishlist(user_id);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_wishlist_product ON product_wishlist(product_id);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 5) Auth/Security
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_token_blacklist_user ON token_blacklist(user_id) WHERE user_id IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_fail2ban_user        ON fail2ban_log(user_id) WHERE user_id IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 6) Payments
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_asaas_webhook_order      ON asaas_webhook_events(order_id) WHERE order_id IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_asaas_splits_order_item  ON asaas_splits(order_item_id) WHERE order_item_id IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_coupon_uses_order        ON coupon_uses(order_id);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 7) Disputes
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_disputes_mediator ON disputes(mediator_user_id) WHERE mediator_user_id IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_disputes_opener   ON disputes(opened_by_user_id);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 8) Search log clicked
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_search_log_clicked ON search_log(clicked_product_id) WHERE clicked_product_id IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- Registro da migration (tolerante se tabela ainda nao existe)
-- =====================================================================
DO $$ BEGIN
  INSERT INTO schema_migrations (version, applied_at)
  VALUES ('011_critical_indexes', NOW())
  ON CONFLICT (version) DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- ANALYZE para refresh do planner (fora de DO blocks)
ANALYZE product_views;
ANALYZE loyalty_transactions;
ANALYZE user_loyalty;
ANALYZE product_qna;
ANALYZE product_wishlist;
ANALYZE asaas_webhook_events;
ANALYZE coupon_uses;
