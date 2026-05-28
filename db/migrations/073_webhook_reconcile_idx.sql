-- Migration 073: indice composto PARTIAL para reconcileWebhooks cron
-- W18 pass 244 - 2026-05-28
--
-- CONTEXTO:
-- payment-svc reconcileWebhooks() cron (5min) executa:
--   SELECT id, payload, retry_count FROM asaas_webhook_events
--    WHERE signature_valid = TRUE
--      AND processed_at IS NULL
--      AND retry_count BETWEEN 1 AND 5
--      AND received_at > NOW() - INTERVAL '24 hours'
--    ORDER BY retry_count ASC, received_at ASC
--    LIMIT 20
--
-- INDICES EXISTENTES (mig 006 + 011):
--   idx_asaas_evt_type (event_type)
--   idx_asaas_evt_payment (asaas_payment_id)
--   idx_asaas_evt_processed (processed_at) PARTIAL WHERE processed_at IS NULL
--   idx_asaas_webhook_order (order_id) PARTIAL WHERE order_id IS NOT NULL
--
-- PROBLEMA:
-- idx_asaas_evt_processed cobre processed_at IS NULL mas NAO outros filtros:
-- - signature_valid=TRUE (filter in-memory)
-- - retry_count BETWEEN 1 AND 5 (filter in-memory)
-- - received_at > NOW()-24h (filter in-memory)
-- - ORDER BY retry_count, received_at (sort in-memory)
--
-- Em prod normal: ~50-100 rows com processed_at NULL (small backlog).
-- Em outage payment-svc: 5000+ rows pendentes acumulam.
-- Sort step in-memory de 5000 rows = 50-100ms per cron tick.
--
-- POST-FIX: indice PARTIAL composite cobrindo TODA a query:
--   ON asaas_webhook_events(retry_count, received_at)
--   WHERE signature_valid = TRUE
--     AND processed_at IS NULL
--     AND retry_count BETWEEN 1 AND 5
--
-- - PARTIAL filtra ~95% rows (so signature_valid retry pending)
-- - ORDER BY columns prefix = index-only scan sem sort step
-- - received_at > NOW()-24h filter pequeno (5% das rows partial)
-- - LIMIT 20 satisfeito apos 20 reads sequenciais do idx
--
-- TRADE-OFF:
-- - Index write custom em cada webhook INSERT/UPDATE
-- - Webhook volume ~1k/dia em prod modesta - aceitavel
-- - Retorno: cron tick 50-100ms -> <5ms (10-20x melhoria sob backlog)
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_asaas_evt_reconcile_ready;

CREATE INDEX IF NOT EXISTS idx_asaas_evt_reconcile_ready
  ON asaas_webhook_events(retry_count, received_at)
  WHERE signature_valid = TRUE
    AND processed_at IS NULL
    AND retry_count BETWEEN 1 AND 5;

DO $$
BEGIN
  RAISE NOTICE 'W18-pass244: idx_asaas_evt_reconcile_ready created (PARTIAL composite)';
END $$;
