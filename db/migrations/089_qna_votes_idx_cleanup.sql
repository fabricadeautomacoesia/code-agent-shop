-- Migration 089: cleanup product_qna_votes idx (drop redundant + add user lookup)
-- W14 pass 377 - 2026-05-28
--
-- CONTEXTO:
-- product_qna_votes tabela (mig 010 linha 6-13) tem:
--   PRIMARY KEY (qna_id, user_id)  -- composto
--   idx_qna_votes_qna (qna_id)     -- REDUNDANTE (PK left-prefix ja cobre)
--
-- QUERIES atuais (review-svc):
--   WHERE qna_id = $1 AND user_id = $2  -> PK direct lookup (idx_qna_votes_qna nao usado)
--   WHERE qna_id = $1                   -> PK left-prefix scan (idx_qna_votes_qna nao usado)
--   No queries: WHERE user_id alone (mas seria util analytics)
--
-- ANALISE:
-- - PG NUNCA usa idx_qna_votes_qna - PK (qna_id, user_id) left-prefix domina
-- - idx_qna_votes_qna ocupa storage + slow write (em CADA upvote/unvote)
-- - PG_INDEX bloat detector eventually marca como unused
--
-- LACUNA REAL:
-- WHERE user_id alone NAO tem idx (PK trailing-column nao usa).
-- Use cases futuros:
--   - Admin "histórico de votos do user X" (debug abuse)
--   - GDPR direito-acesso (user solicita historico)
--   - Analytics "user com mais upvotes dados"
-- Sem idx user_id, queries forcam Seq Scan em product_qna_votes (cresce ~5k/dia ativo).
--
-- POST-FIX:
-- - DROP idx_qna_votes_qna (redundante - PK cobre)
-- - CREATE idx_qna_votes_user (user_id) NEW
--
-- TRADE-OFF:
-- Net zero idx writes (drop 1 + add 1) - same write cost.
-- Storage neutral.
-- READ optimizada para user lookup pattern.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS idx_qna_votes_user;
--   CREATE INDEX IF NOT EXISTS idx_qna_votes_qna ON product_qna_votes(qna_id);

DROP INDEX IF EXISTS idx_qna_votes_qna;

CREATE INDEX IF NOT EXISTS idx_qna_votes_user
  ON product_qna_votes(user_id, created_at DESC);

ANALYZE product_qna_votes;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass377: idx_qna_votes_qna DROPPED (redundant PK) + idx_qna_votes_user CREATED (user lookup)';
END $$;
