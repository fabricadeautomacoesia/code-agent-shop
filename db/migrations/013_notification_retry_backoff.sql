-- Migration 013: notifications retry backoff + concurrency (WORKER 13)
--
-- BUGS CORRIGIDOS:
-- 1. Race condition: multiplas replicas do notification-svc selecionavam o mesmo
--    batch de notifications -> double-send de emails.
-- 2. Sem backoff: retries de 30s em 30s queimavam as 5 tentativas em 2,5 min,
--    marcando 'failed' antes do SMTP recuperar de uma falha transitoria.
--
-- COLUNAS:
-- - next_retry_at: quando proxima tentativa esta liberada (exponential backoff)
-- - locked_by/locked_at: optimistic claim sem precisar FOR UPDATE pesado
--
-- INDICE: o processor consulta WHERE sent_status='pending' AND channel IN(...)
--   AND next_retry_at <= NOW() AND retry_count < 5 - precisa de indice partial.

DO $$ BEGIN
  ALTER TABLE notifications ADD COLUMN next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE notifications ADD COLUMN locked_by    VARCHAR(80);
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE notifications ADD COLUMN locked_at    TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

-- Indice para o processor (SELECT pending + channel + next_retry_at + retry_count)
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_notif_outbox_ready ON notifications(channel, next_retry_at, priority DESC, created_at ASC)
    WHERE sent_status = 'pending' AND retry_count < 5;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

-- Recover locks travados > 5 minutos (worker que crashou)
-- (sera rodado em loop pelo notif-svc tambem, mas garante baseline pos-migration)
DO $$ BEGIN
  UPDATE notifications
     SET locked_by = NULL, locked_at = NULL
   WHERE locked_at IS NOT NULL AND locked_at < NOW() - INTERVAL '5 minutes';
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  INSERT INTO schema_migrations (version, applied_at)
  VALUES ('013_notification_retry_backoff', NOW())
  ON CONFLICT (version) DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
