-- ============================================================
-- Migration 044: product_reviews.reply_by_admin + reply_by_user_id
-- FIX-WORKER-7 pass 37: paralelo a migration 043 (qna_answered_by_admin)
-- ============================================================
-- CONTEXTO:
--   Pre-fix POST /:id/reply: SO seller dono podia responder review.
--   Admin com role=admin sem entry sellers -> 404 silencioso.
--   Use cases legitimos admin reply:
--     - Seller inativo > 30d com review negativa -> admin esclarece
--     - Review com desinformacao -> admin corrige publicamente
--     - Disputa: admin posta resposta oficial
--
--   Pre-fix schema product_reviews so tinha reply_from_seller TEXT.
--   Sem flag distinguir reply seller vs admin (UI mostra mesma cor).
--   Sem registro de QUEM respondeu (audit forense impossivel).
-- ============================================================

-- 1. ADD COLUMN reply_by_admin (flag - paralelo a answered_by_admin pass 36)
ALTER TABLE product_reviews
  ADD COLUMN IF NOT EXISTS reply_by_admin BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN product_reviews.reply_by_admin IS
  'FIX-W7-37: TRUE quando admin/staff respondeu review (vs seller dono). UI badge "Resposta da plataforma".';

-- 2. ADD COLUMN reply_by_user_id (forense - QUEM respondeu especificamente)
-- Pre-fix: reply_from_seller TEXT sem registro do user_id que respondeu.
-- Audit log existe mas link explicit ao review.user_id facilita query SLA.
ALTER TABLE product_reviews
  ADD COLUMN IF NOT EXISTS reply_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN product_reviews.reply_by_user_id IS
  'FIX-W7-37: user_id de quem respondeu (seller dono OU admin/staff). Forense + SLA tracking.';

-- 3. PARTIAL IDX p/ admin auditoria respostas (paralelo idx qna pass 36)
CREATE INDEX IF NOT EXISTS idx_reviews_reply_by_admin
  ON product_reviews(reply_at DESC)
  WHERE reply_by_admin = TRUE;

COMMENT ON INDEX idx_reviews_reply_by_admin IS
  'FIX-W7-37: partial idx auditoria respostas admin (volume, SLA, top-categories).';
