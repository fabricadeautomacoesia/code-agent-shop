-- Migration 090: idx PARTIAL asaas_webhook_events dead webhooks
-- W14 pass 393 - 2026-05-28
--
-- CONTEXTO:
-- payment-svc /payments/webhooks/dead endpoint (admin) lista webhooks
-- com retry_count > 5 (esgotaram retries) p/ investigation manual.
-- Query (pass 1319 server.js):
--   SELECT id, event_type, asaas_payment_id, processing_error, retry_count, received_at
--    FROM asaas_webhook_events
--    WHERE signature_valid = TRUE
--      AND processed_at IS NULL
--      AND retry_count > 5
--    ORDER BY received_at DESC, id DESC
--    LIMIT N OFFSET M
--
-- INDICES EXISTENTES (mig 006 + 011 + 073):
--   idx_asaas_evt_type (event_type)
--   idx_asaas_evt_payment (asaas_payment_id)
--   idx_asaas_evt_processed (processed_at) PARTIAL WHERE processed_at IS NULL
--   idx_asaas_webhook_reconcile (retry_count, received_at) PARTIAL
--     WHERE signature_valid AND processed_at IS NULL AND retry_count BETWEEN 1 AND 5
--
-- LACUNA:
-- - mig 073 idx PARTIAL exclui retry_count > 5 (dead webhooks)
-- - /webhooks/dead admin endpoint forca Bitmap Heap em
--   idx_asaas_evt_processed (processed_at IS NULL) + Filter retry_count > 5
-- - Sort step in-memory ORDER BY received_at DESC
-- - Admin dashboard polling 30s cache (pass 1321) - cache hit cobre maioria
--   MAS post-restart payment-svc / Redis flush -> primeira call MISS
-- - Em incident Asaas outage: 50-200 dead webhooks acumulam -> slow audit
--
-- POST-FIX: idx PARTIAL composite p/ dead webhooks query
--   ON asaas_webhook_events(received_at DESC, id DESC)
--   WHERE signature_valid = TRUE
--     AND processed_at IS NULL
--     AND retry_count > 5
--
-- - PARTIAL filtra rare event class (~0.1% rows em prod normal)
-- - ORDER BY columns matched -> no Sort node
-- - Latencia esperada: ~5-15ms (vs 50-200ms Bitmap + Sort)
--
-- TRADE-OFF: idx write apenas em retry_count cross 5 boundary (raro).
-- Storage minimo (~0.1% rows com dead = ~100-500 entries em base 100k+).
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_asaas_webhook_dead;

CREATE INDEX IF NOT EXISTS idx_asaas_webhook_dead
  ON asaas_webhook_events(received_at DESC, id DESC)
  WHERE signature_valid = TRUE
    AND processed_at IS NULL
    AND retry_count > 5;

ANALYZE asaas_webhook_events;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass393: idx_asaas_webhook_dead PARTIAL (admin /webhooks/dead query)';
END $$;
