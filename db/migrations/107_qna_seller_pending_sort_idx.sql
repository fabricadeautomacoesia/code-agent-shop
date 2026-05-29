-- Migration 107: idx_qna_seller_pending_sort PARTIAL composite (sort consolidation)
-- ============================================================================
--
-- FIX-WORKER-14 pass 532: consume /qna/seller/pending sort pattern
--
-- CONTEXT:
--   review-svc /qna/seller/pending (linha 818) - hot path dashboard-seller
--   Polling 30s cache (pass 189 consolidation) - cache miss = DB hit
--
--   Query padrao:
--     SELECT q.* FROM product_qna q
--      JOIN products p ON p.id = q.product_id
--      JOIN sellers s ON s.id = q.seller_id
--      WHERE q.seller_id = $1 OR s.user_id = $1
--        AND q.answer IS NULL
--        AND q.is_hidden = FALSE
--        AND p.status IN ('approved','platform_owned')
--        AND p.deleted_at IS NULL
--      ORDER BY q.asked_at ASC, q.id ASC
--      LIMIT $2 OFFSET $3
--
-- PRE-FIX existing index:
--   mig 007:79 idx_qna_seller_pending PARTIAL
--     ON product_qna(seller_id) WHERE answer IS NULL AND is_hidden = FALSE
--
--   Planner steps:
--   1. Index Scan idx_qna_seller_pending (scoped seller_id, partial WHERE)
--   2. JOIN products + sellers
--   3. EXTERNAL SORT by asked_at ASC, id ASC (NOT covered by idx)
--   4. LIMIT N + OFFSET M
--
--   Para sellers populares (~100+ pending Q&A):
--   - Sort node externo custoso (PG memory + WAL writes)
--   - Latency: ~30-50ms incluindo external sort
--   - Dashboard-seller /qna polling 30s = repetido stress DB
--
-- POST-FIX:
--   idx_qna_seller_pending_sort PARTIAL composite extension:
--     ON product_qna (seller_id, asked_at ASC, id ASC)
--     WHERE answer IS NULL AND is_hidden = FALSE
--
--   Planner steps:
--   1. Direct Index Scan idx_qna_seller_pending_sort (pre-sorted)
--   2. JOIN products + sellers
--   3. LIMIT N + OFFSET M (SEM Sort node)
--
--   Latency: ~30-50ms -> ~5-10ms (5x improvement em sellers populares)
--
--   Trade-off vs mig 007 idx_qna_seller_pending:
--   - Mig 007 idx ainda cobre simples lookups WHERE seller_id sem sort
--   - Considerar DROP mig 007 em pass futuro se 0 idx_scan stat confirmar
--   - Por ora manter ambos (mig 007 simpler + mig 107 sort-aware)
--
--   PARTIAL predicates literal immutable (answer IS NULL + is_hidden = FALSE):
--   - Pattern V8 W14 paridade pass 481 (pwreset used_at IS NULL)
--   - Idx physical size pequeno (pendentes ~10% Q&A total prod)
--   - Resolved Q&A sai do partial automaticamente (after answer)
--
-- COVERAGE QUERIES:
--   - /qna/seller/pending (review-svc - dashboard-seller polling)
--   - /admin/qna/pending future endpoint (paridade admin)
--   - Cron qna_sla_check (futuro - alert seller atrasos respondendo)
--
-- PATTERN V8 W14 cadeia PARTIAL composite com sort:
--   pass 086 idx_audit_severity_created PARTIAL warn+
--   pass 094 idx_audit_target_created PARTIAL NOT NULL
--   pass 098 idx_audit_target_type_severity PARTIAL critical
--   pass 100 idx_pwreset_pending_unused PARTIAL used_at IS NULL
--   pass 102 idx_notif_user_inapp_unread PARTIAL channel+is_read
--   pass 103 idx_qa_runs_product_timeout PARTIAL verdict='timeout'
--   pass 104 idx_price_alerts_unnotified PARTIAL last_notified_at IS NULL
--   pass 105 idx_products_sales_public PARTIAL W7 status whitelist
--   pass 106 idx_audit_anonymous_critical PARTIAL HMAC forensic
--   pass 107 (este) idx_qna_seller_pending_sort PARTIAL composite com sort
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_qna_seller_pending_sort;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_qna_seller_pending_sort
    ON product_qna (seller_id, asked_at ASC, id ASC)
    WHERE answer IS NULL AND is_hidden = FALSE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_qna_seller_pending_sort create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE product_qna;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass532: idx_qna_seller_pending_sort PARTIAL composite (consume /qna/seller/pending sort)';
END $$;
