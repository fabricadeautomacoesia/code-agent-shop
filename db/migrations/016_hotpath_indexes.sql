-- Migration 016: Indices criticos pos-audit (WORKER 14 pass 2)
-- Audit pg_stat_user_tables revelou tabelas com >50% seq_scan + queries
-- conhecidas sem suporte de indice (orders cron, reviews recents, etc).
-- Todos com DO blocks tolerantes a tabela ausente.

-- =====================================================================
-- 1) orders.expires_at - cron de expiracao de orders pending faz full scan
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_orders_expires_pending ON orders(expires_at)
    WHERE status = 'pending_payment';
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 2) reviews.created_at DESC - ORDER BY recents
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_reviews_recent ON product_reviews(product_id, created_at DESC);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 3) search_log full text search (TSV) + janela 7d
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_search_log_recent ON search_log(created_at DESC, query_normalized);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 4) product_qna_votes - anti-double-vote (qna_id + user_id)
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_qna_votes_user ON product_qna_votes(user_id, qna_id);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 5) review_votes - anti-double-vote
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_review_votes_user ON review_votes(user_id, review_id);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 6) notification_templates por template_code (usado no outbox lookup)
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_notif_tmpl_code ON notification_templates(template_code);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 7) user_notification_prefs por user_id (lookup pra check opt-out)
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_unotif_prefs_user ON user_notification_prefs(user_id);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 8) metrics_history - serie temporal (collected_at DESC)
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_metrics_collected ON metrics_history(collected_at DESC);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 9) product_media por product_id (galeria + cover lookup)
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_product_media_product ON product_media(product_id, sort_order);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- =====================================================================
-- 10) seller_follows - "minhas seguindo" listing
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_seller_follows_follower ON seller_follows(follower_user_id, created_at DESC);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_seller_follows_seller ON seller_follows(seller_id);
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- ANALYZE para refresh do planner
ANALYZE orders;
ANALYZE product_reviews;
ANALYZE search_log;
ANALYZE metrics_history;
ANALYZE product_media;

DO $$ BEGIN
  INSERT INTO schema_migrations (version, applied_at)
  VALUES ('016_hotpath_indexes', NOW())
  ON CONFLICT (version) DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
