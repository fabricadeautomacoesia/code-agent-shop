-- Migration 022: Refined outbox index (WORKER 18 pass 3)
-- =====================================================================
-- PROBLEMA:
-- O index idx_notif_outbox_ready ja existia mas tinha gap:
--   CREATE INDEX idx_notif_outbox_ready ON notifications
--     (channel, next_retry_at, priority DESC, created_at)
--     WHERE sent_status = 'pending' AND retry_count < 5
--
-- A query do outbox processor (services/notification-svc/server.js:160)
-- filtra TAMBEM por locked_by IS NULL. Como esse predicate nao esta no
-- WHERE parcial, Postgres precisa fazer:
--   1) Index Scan no idx (matchando pending + retry_count < 5)
--   2) Re-check de locked_by IS NULL em HEAP de cada row encontrada
--
-- A 4 rows hoje, Postgres prefere Seq Scan (mais barato). A 50k+ rows,
-- isso vira gargalo do cron 30s (processOutbox).
--
-- SOLUCAO:
-- Indice partial mais especifico que adiciona locked_by IS NULL ao WHERE
-- parcial. Mantem idx_notif_outbox_ready para queries que tambem usam
-- next_retry_at em ORDER BY (caso futuro), mas a query atual prefere o novo
-- (mais selective).
-- =====================================================================
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_notif_outbox_unlocked
    ON notifications(channel, next_retry_at, priority DESC, created_at)
    WHERE sent_status = 'pending'
      AND retry_count < 5
      AND locked_by IS NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
