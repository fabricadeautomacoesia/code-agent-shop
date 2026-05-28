-- Migration 079: idx composto admin queue + cron liquidator
-- W18 pass 273 - 2026-05-28
--
-- CONTEXTO:
-- Pass 270 mig 078 criou payouts_pending_wallet + 3 indices:
--   idx_pending_wallet_seller_pending (seller_id) PARTIAL WHERE status='pending'
--   idx_pending_wallet_order (order_id)
--   idx_pending_wallet_created (created_at DESC)
--
-- Pass 273 W4 adicionou endpoint admin /payouts-pending-wallet com:
--   WHERE pw.status='pending' (ou IN para 'all')
--   ORDER BY pw.created_at ASC, pw.id ASC
-- Pass 272 cron liquidator faz:
--   WHERE pw.status='pending' AND s.asaas_wallet_id IS NOT NULL
--   ORDER BY pw.created_at ASC, pw.id ASC
--   LIMIT 50 FOR UPDATE SKIP LOCKED
--
-- PROBLEMA (cron + admin):
-- - Indice idx_pending_wallet_created ordena DESC (admin/cron usa ASC)
-- - Idx_pending_wallet_seller_pending cobre seller-side mas nao admin/cron
-- - Cron + admin convergem em scan + sort overhead
--
-- POST-FIX: idx PARTIAL composite p/ pending queue FIFO:
--   ON payouts_pending_wallet(created_at ASC, id ASC) WHERE status='pending'
-- - PARTIAL filtra liquidated/forfeited (rows liquidadas eventualmente >>
--   pending em mature prod)
-- - ASC composite FIFO oldest first (admin SLA + cron retry order)
-- - Index Scan -> elimina Sort step
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_pending_wallet_pending_queue;

CREATE INDEX IF NOT EXISTS idx_pending_wallet_pending_queue
  ON payouts_pending_wallet(created_at ASC, id ASC)
  WHERE status = 'pending';

DO $$
BEGIN
  RAISE NOTICE 'W18-pass273: idx_pending_wallet_pending_queue created (PARTIAL FIFO)';
END $$;
