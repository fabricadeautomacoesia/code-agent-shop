-- ============================================================
-- Migration 043: product_qna.answered_by_admin
-- FIX-WORKER-7 pass 36: flag admin override em POST /qna/:id/answer
-- ============================================================
-- CONTEXTO:
--   Pre-fix: admin com role=admin nao podia responder qna (JOIN sellers
--   exigia req.user ser dono via sellers.user_id). Bug 2 pass 36.
--   Pos-fix: admin path skip ownership + flag answered_by_admin=TRUE
--   p/ UI distinguir resposta seller vs resposta admin (transparencia).
--
-- USE CASES:
--   - Seller inativo (>30d sem login) - admin responde para nao perder venda
--   - Admin esclarece duvida tecnica complexa
--   - Disputa: admin responde com decisao final visivel a buyer
-- ============================================================

ALTER TABLE product_qna
  ADD COLUMN IF NOT EXISTS answered_by_admin BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN product_qna.answered_by_admin IS
  'FIX-W7-36: TRUE quando admin/staff respondeu (vs seller dono). UI mostra "Resposta da plataforma" em vez de seller name.';

-- Idx parcial p/ admin queue "answers by admin" (auditoria + analytics)
CREATE INDEX IF NOT EXISTS idx_qna_answered_by_admin
  ON product_qna(answered_at DESC)
  WHERE answered_by_admin = TRUE;

COMMENT ON INDEX idx_qna_answered_by_admin IS
  'FIX-W7-36: partial idx p/ admin auditar respostas por staff (volume, SLA, etc).';
