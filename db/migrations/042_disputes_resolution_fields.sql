-- ============================================================
-- Migration 042: disputes.resolution_action + idx admin queue
-- FIX-WORKER-7 pass 31 / W4: suporte a /admin/disputes endpoints novos.
-- ============================================================
-- CONTEXTO:
--   Schema original (mig 007): dispute_status enum
--     opened|under_review|resolved_buyer|resolved_seller|cancelled
--   Endpoint admin novo (orders.js W4): precisa registrar TIPO de resolucao
--     (refund_approved, refund_denied, replacement_sent, partial_refund, dismissed)
--   mig 007 ja tem: refund_amount_cents, mediator_notes, mediator_user_id
--   Falta: resolution_action enum + idx p/ queue admin priorizada

-- Coluna nova: action especifica da resolucao
ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS resolution_action VARCHAR(40);

COMMENT ON COLUMN disputes.resolution_action IS
  'FIX-W4: tipo da resolucao admin: refund_approved|refund_denied|replacement_sent|partial_refund|dismissed';

-- POST UPDATE pos-deploy: backfill cancelled / resolved (sem action info historica)
-- Manual no console SQL admin se desejar.

-- IDX p/ admin queue (FILTER status pending + ORDER opened_at)
CREATE INDEX IF NOT EXISTS idx_disputes_admin_queue
  ON disputes(status, opened_at ASC)
  WHERE status IN ('opened','under_review');

COMMENT ON INDEX idx_disputes_admin_queue IS
  'FIX-W4: partial idx p/ admin queue prioridade. Cobre /admin/disputes filter status open/investigating + ORDER opened_at.';
