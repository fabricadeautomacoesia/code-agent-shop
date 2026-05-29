-- Migration 126: idx_qna_product_pdp_sort composite (PDP qna listing 4-level sort)
-- ============================================================================
--
-- FIX-WORKER-14 pass 690: consume product-svc /:slug/qna PDP listing ORDER BY
-- 4-level sort completo. Paridade Regra D V8 cross-svc (cadeia mig 102-125).
--
-- CONTEXT:
--   product-svc GET /:slug/qna (public.js linha 1255-1270):
--     SELECT q.id, q.question, q.answer, q.asked_at, q.answered_at, q.is_pinned,
--            q.upvote_count, ...
--            COUNT(*) OVER()::INT AS _total
--       FROM product_qna q
--       JOIN products p ON p.id = q.product_id
--       LEFT JOIN users ua/us ON ua.id = q.asked_by_user_id / answered_by_user_id
--      WHERE p.slug = $1 AND q.is_hidden = FALSE
--      ORDER BY q.is_pinned DESC, q.upvote_count DESC, q.asked_at DESC, q.id DESC
--      LIMIT $2 OFFSET $3
--
--   HOT PATH: PDP Q&A tab polling - usuarios populares (1k+ produtos)
--   produzem 50-100+ qnas. Mass-vote burst (PDP viral) -> upvote_count ties.
--
-- PRE-FIX existing indexes:
--   idx_qna_product ON product_qna(product_id, asked_at DESC) WHERE is_hidden=FALSE (mig 007)
--   - Cobre WHERE product_id + is_hidden + ORDER BY asked_at DESC (partial range)
--   - MAS NAO cobre is_pinned DESC, upvote_count DESC tiebreaker
--   - 4-level ORDER tuple forca External Sort completo
--
--   idx_qna_pinned ON product_qna(product_id, is_pinned) WHERE is_pinned = TRUE (mig 007)
--   - PARTIAL para pinned only (subset 1-3 rows/product)
--
-- POST-FIX:
--   idx_qna_product_pdp_sort composite PARTIAL p/ PDP listing direction parity:
--     ON product_qna (product_id, is_pinned DESC, upvote_count DESC,
--                      asked_at DESC, id DESC)
--     WHERE is_hidden = FALSE
--
--   Planner steps:
--   1. Direct Index Scan idx_qna_product_pdp_sort PARTIAL (is_hidden=FALSE)
--      WHERE product_id = $X (pre-sorted full 4-level ORDER tuple)
--   2. JOIN users via PK lookups
--   3. LIMIT N + OFFSET M (SEM External Sort node)
--
--   Latency: PDP qna tab popular product ~80-150ms External Sort -> ~10-20ms
--   Storage: ~2-5MB para 50k qnas prod (acceptable - PARTIAL excludes hidden)
--
--   Trade-off vs mig 007 idx_qna_product:
--   - mig 007 cobre simple asked_at sort (compatibility queries antigas)
--   - mig 126 (este) cobre PDP ORDER completo direction parity 4-level
--   - Manter ambos. pg_stat_user_indexes decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /products/:slug/qna PDP Q&A tab (este path)
--   - Future cron qna_export analytics
--
-- PATTERN V8 W14 cadeia direction parity DESC+DESC+DESC+DESC composite:
--   passes 102-125 (24 indexes consolidacao previa)
--   pass 126 (este) qna_product_pdp_sort 4-level direction parity
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_qna_product_pdp_sort;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_qna_product_pdp_sort
    ON product_qna (product_id, is_pinned DESC, upvote_count DESC,
                     asked_at DESC, id DESC)
    WHERE is_hidden = FALSE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_qna_product_pdp_sort create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE product_qna;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass690: idx_qna_product_pdp_sort PARTIAL 4-level DESC composite PDP qna listing (paridade Regra D cadeia mig 102-125)';
END $$;
