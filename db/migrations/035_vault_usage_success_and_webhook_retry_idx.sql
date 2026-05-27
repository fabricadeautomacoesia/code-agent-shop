-- FIX-WORKER-14 pass 7: 2 indices novos baseados em queries reais identificadas
-- em audits previos (W17 pass 9 + W11 pass 6).
--
-- AUDIT db schema (47 tabelas):
-- Apos passes 1-6 cobrir hotpath, notifications, carts, payouts, qa_runs etc,
-- restam dois GAPs em queries de monitoring/reconciliacao:
--
-- 1. vault_key_usage: W17 pass 9 estabeleceu que dashboard admin vai medir
--    error rate por chave (success=FALSE GROUP BY vault_key_id). Sem indice,
--    table scan completa cada query. Volume estimado: 10k+ rows/mes por chave
--    ativa, mas error rate visivel apenas em audit semanal/mensal.
--
-- 2. asaas_webhook_events: W11 pass 6 introduziu retry_count incremento em
--    falhas processing. Admin/cron de reconciliacao precisa listar webhooks
--    com retry_count > 0 para reprocessar manualmente. Sem indice, query
--    scan ~100k+ rows/mes (volume webhook Asaas em prod ativo).
--
-- AMBOS sao indices PARTIAL (WHERE clause) - menores e mais focados que
-- full indexes em colunas com baixa cardinalidade (success boolean /
-- retry_count com 99% rows = 0).

-- ============================================================
-- INDEX 1: vault_key_usage error rate analysis
-- ============================================================
-- Query padrao admin dashboard (futuro W4 pass 8 /admin/vault):
--   SELECT vault_key_id, COUNT(*) FILTER (WHERE NOT success)::FLOAT
--          / COUNT(*) AS error_rate
--     FROM vault_key_usage
--    WHERE created_at > NOW() - INTERVAL '7 days'
--    GROUP BY vault_key_id
--    HAVING COUNT(*) FILTER (WHERE NOT success) > 0;
--
-- Sem indice: seq scan + group by sort em ~70k rows/semana.
-- Com partial idx WHERE NOT success: ~700 rows max (error rate <1% tipico).
-- ~100x menos work.
CREATE INDEX IF NOT EXISTS idx_vault_usage_failures
  ON vault_key_usage (vault_key_id, created_at DESC)
  WHERE success = FALSE;

COMMENT ON INDEX idx_vault_usage_failures IS
  'W14-7: partial idx p/ admin error rate analysis. Cobre apenas rows com success=FALSE (~1% tipico).';

-- ============================================================
-- INDEX 2: asaas_webhook_events retry reconciliation
-- ============================================================
-- Query padrao cron reconciliation (futuro W11 pass 7):
--   SELECT id, event_type, processing_error, retry_count
--     FROM asaas_webhook_events
--    WHERE signature_valid AND retry_count > 0
--      AND received_at > NOW() - INTERVAL '24 hours'
--    ORDER BY retry_count DESC, received_at ASC LIMIT 50;
--
-- Sem indice: seq scan ~100k rows/mes em produto ativo.
-- Com partial idx WHERE retry_count > 0: ~10-100 rows (falhas raras).
-- Indice ORDENADO por retry_count DESC + received_at ASC = sort eliminado.
CREATE INDEX IF NOT EXISTS idx_asaas_evt_retry
  ON asaas_webhook_events (retry_count DESC, received_at ASC)
  WHERE retry_count > 0 AND signature_valid = TRUE;

COMMENT ON INDEX idx_asaas_evt_retry IS
  'W14-7: partial idx p/ cron reconciliation. Cobre webhooks validos com retry_count>0 (falhas raras).';

-- Validacao pos-apply:
--   EXPLAIN ANALYZE
--     SELECT * FROM vault_key_usage
--      WHERE vault_key_id = '<uuid>' AND NOT success
--        AND created_at > NOW() - INTERVAL '7 days';
--   Esperado: Index Scan using idx_vault_usage_failures (cost < 5.0)
--
--   EXPLAIN ANALYZE
--     SELECT * FROM asaas_webhook_events
--      WHERE retry_count > 0 AND signature_valid
--      ORDER BY retry_count DESC, received_at ASC LIMIT 50;
--   Esperado: Index Scan using idx_asaas_evt_retry (sem Sort node)

DO $$
BEGIN
  RAISE NOTICE 'W14-7: 2 indices partial criados (vault_usage_failures + asaas_evt_retry)';
END $$;
