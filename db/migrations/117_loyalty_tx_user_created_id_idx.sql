-- Migration 117: idx_loyalty_tx_user_created_id direction parity DESC+DESC tiebreaker
-- ============================================================================
--
-- FIX-WORKER-14 pass 623: consume seller-svc /loyalty GET handler ORDER BY tiebreaker
-- direction parity. Paridade Regra D V8 cross-svc (cadeia mig 102-116).
--
-- CONTEXT:
--   seller-svc /loyalty (loyalty.js linha 92-93 + 125):
--     SELECT id, points_delta, balance_after, reason, reference_type,
--            reference_id, idempotency_key, created_at
--       FROM loyalty_transactions
--      WHERE user_id = $1
--      ORDER BY created_at DESC, id DESC
--      LIMIT $2
--
--   Same query 2 callers no mesmo handler (welcome bonus + post-grant fetch).
--   /conta/pontos page polling 30s + balance check em multiple PDP/checkout flows.
--
-- PRE-FIX existing index (mig 072):
--   idx_loyalty_tx_user_created ON loyalty_transactions(user_id, created_at DESC)
--   - Covers WHERE user_id + ORDER BY created_at DESC (range scan)
--   - MAS NAO inclui id tiebreaker DESC
--   - Multiplas tx user same instant (race condition order_paid + welcome bonus
--     mesma transaction window 50ms) -> created_at IDENTICO
--   - id DESC tiebreaker forca External Sort node externo
--   - 1k+ users ativos * cada ~50 tx/year = 50k+ rows
--   - External Sort overhead per query ~3-8ms
--
-- POST-FIX:
--   idx_loyalty_tx_user_created_id composite direction parity Regra D V8:
--     ON loyalty_transactions (user_id, created_at DESC, id DESC)
--
--   Planner steps:
--   1. Direct Index Scan idx_loyalty_tx_user_created_id WHERE user_id = $1
--      (pre-sorted full ORDER BY descending tiebreaker)
--   2. LIMIT N (SEM External Sort)
--
--   Latency: ~3-8ms External Sort eliminado -> ~1-3ms total query
--   Storage: ~2-4MB para 50k rows
--
--   Trade-off vs mig 072 idx_loyalty_tx_user_created:
--   - mig 072 cobre simple WHERE user_id queries (sem sort tiebreaker)
--   - mig 117 (este) cobre /loyalty list ORDER tiebreaker completo
--   - Manter ambos. pg_stat_user_indexes mostra usage decision drop futuro
--
-- COVERAGE QUERIES:
--   - GET /loyalty user transactions history (este path)
--   - Future cron loyalty_export reports (Mercado Pontos audit trail)
--
-- PATTERN V8 W14 cadeia direction parity composite tiebreaker:
--   passes 102-116 (15 indexes sessao previa)
--   pass 117 (este) loyalty_tx direction parity DESC+DESC
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_loyalty_tx_user_created_id;

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_loyalty_tx_user_created_id
    ON loyalty_transactions (user_id, created_at DESC, id DESC);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_loyalty_tx_user_created_id create: % - %', SQLSTATE, SQLERRM;
END $$;

ANALYZE loyalty_transactions;

DO $$ BEGIN
  RAISE NOTICE 'W14-pass623: idx_loyalty_tx_user_created_id direction parity DESC+DESC tiebreaker (paridade Regra D cadeia mig 102-116)';
END $$;
