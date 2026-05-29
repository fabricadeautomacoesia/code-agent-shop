-- Migration 114: idx_wishlist_user_created_v2 composite (fix direction mismatch)
-- ============================================================================
--
-- FIX-WORKER-14 pass 598: consume wishlist GET / ORDER BY direction parity
--
-- CONTEXT:
--   product-svc /products/wishlist (linha 108) - seller dashboard /conta/favoritos
--   Query padrao:
--     SELECT ... FROM product_wishlist w
--       JOIN products p ON p.id = w.product_id
--       LEFT JOIN sellers s ON s.id = p.seller_id
--      WHERE w.user_id = $1 AND p.status IN (...) AND p.deleted_at IS NULL
--      ORDER BY w.created_at DESC, w.product_id DESC
--      LIMIT $2 OFFSET $3
--
-- PRE-FIX existing index (mig 059):
--   idx_wishlist_user_created ON product_wishlist (user_id, created_at DESC, product_id ASC)
--
--   DIRECTION MISMATCH:
--   - Query: ORDER BY created_at DESC, product_id DESC
--   - Index: (user_id, created_at DESC, product_id ASC)
--   - PG planner usa idx para WHERE user_id + range scan created_at DESC
--   - MAS product_id tiebreaker idx ASC vs query DESC -> External Sort externo
--   - Em users veteranos com 100+ wishlist items: sort node custoso (~10-30ms)
--   - Pattern V8 Regra D direction parity (paridade pass 251/256/259/261/271/376)
--     consolidacao ja estabelecido cross-svc - wishlist era LAGGED este aspecto
--
-- POST-FIX:
--   idx_wishlist_user_created_v2 composite paridade direction:
--     ON product_wishlist (user_id, created_at DESC, product_id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_wishlist_user_created_v2 (pre-sorted full ORDER BY)
--   2. JOIN products p (idx pk lookup) + LEFT JOIN sellers
--   3. LIMIT N + OFFSET M (SEM External Sort)
--
--   Latency: ~10-30ms External Sort eliminado -> ~5-10ms total query
--   Storage: ~50-100KB para 10k wishlist items (acceptable)
--
--   Trade-off vs mig 059 idx_wishlist_user_created:
--   - mig 059 (DESC, ASC) cobre queries com ORDER BY direction mista
--   - mig 114 (DESC, DESC) cobre query atual handler
--   - Manter ambos? pg_stat_user_indexes mostra usage decision drop futuro
--   - Alternative: DROP mig 059 + manter so mig 114 (handler V8 direction parity
--     consolidacao established - no use case for ASC tiebreaker em wishlist)
--   - Pragmatic: KEEP both (mig 059 small storage, future DROP via stats)
--
-- COVERAGE QUERIES:
--   - GET /products/wishlist (this path - storefront favoritos page)
--   - Future cron wishlist_price_alert (notify price drops)
--   - Forensic: 'todos items wishlist do user X' (admin investigation)
--
-- PATTERN V8 W14 cadeia direction parity consolidacao:
--   pass 102 idx_notif_user_inapp_unread PARTIAL channel+is_read
--   pass 103 idx_qa_runs_product_timeout PARTIAL verdict='timeout'
--   pass 104 idx_price_alerts_unnotified PARTIAL last_notified_at IS NULL
--   pass 105 idx_products_sales_public PARTIAL status whitelist
--   pass 106 idx_audit_anonymous_critical PARTIAL HMAC forensic
--   pass 107 idx_qna_seller_pending_sort PARTIAL composite sort
--   pass 108 idx_payouts_seller_status_sort composite filter+sort
--   pass 109 idx_disputes_created simple range
--   pass 110 idx_asaas_webhook_dead_admin PARTIAL composite
--   pass 111 idx_qa_runs_llm_cost PARTIAL range
--   pass 112 idx_reports_dedup composite multi-col exact match
--   pass 113 idx_sellers_sla_classb PARTIAL cron-aware state predicate
--   pass 114 (este) idx_wishlist_user_created_v2 direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_wishlist_user_created_v2;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_wishlist_user_created_v2
    ON product_wishlist (user_id, created_at DESC, product_id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_wishlist_user_created_v2 create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE product_wishlist;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass598: idx_wishlist_user_created_v2 direction parity DESC+DESC (paridade Regra D V8 251/256/259/261/271/376)';
END $$;
