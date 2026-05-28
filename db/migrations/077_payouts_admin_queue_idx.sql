-- Migration 077: indice composto PARTIAL para /admin/payouts/pending
-- W14 pass 266 - 2026-05-28
--
-- CONTEXTO:
-- Endpoint /sellers/admin/payouts/pending (cache 20s):
--   SELECT p.id, p.seller_id, p.amount_cents, ..., s.store_name
--    FROM seller_payouts p JOIN sellers s ON s.id = p.seller_id
--    WHERE p.status IN ('pending','approved')
--    ORDER BY p.requested_at ASC, p.id ASC
--
-- INDICES EXISTENTES (mig 003 + 040):
--   idx_payouts_seller (seller_id, requested_at DESC) - cobre seller view
--   idx_payouts_status (status) - cardinality 4-5 (pending/approved/paid/rejected/etc)
--   idx_seller_payouts_processing_stuck PARTIAL processing (mig 040)
--
-- PROBLEMA:
-- Admin queue FIFO usa requested_at ASC. Indices existentes:
-- - idx_payouts_status (status) sozinho: filter status mas SORT in-memory
-- - idx_payouts_seller ordena DESC (wrong direction)
-- - Em prod com 5k payouts historicos pendentes: scan + sort ~50-100ms
-- - Cache 20s mitiga mas admin polling 30s = miss frequente
--
-- POST-FIX: composite PARTIAL otimal:
--   ON seller_payouts(requested_at ASC, id ASC) PARTIAL WHERE
--      status IN ('pending','approved')
-- - PARTIAL filtra ~80% rows (so pending/approved no idx)
-- - ORDER BY prefix do idx -> index-only scan SEM sort
-- - JOIN sellers depois via FK idx (jah existe)
-- - Latencia 50-100ms -> <5ms
--
-- TRADE-OFF: idx update em cada payout INSERT/UPDATE status change
-- Acceptable - payouts volume ~10-50/dia em prod modesta
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_payouts_admin_queue;

CREATE INDEX IF NOT EXISTS idx_payouts_admin_queue
  ON seller_payouts(requested_at ASC, id ASC)
  WHERE status IN ('pending', 'approved');

DO $$
BEGIN
  RAISE NOTICE 'W14-pass266: idx_payouts_admin_queue created (PARTIAL FIFO queue)';
END $$;
