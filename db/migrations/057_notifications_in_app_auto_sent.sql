-- Migration 057: trigger auto-sent_status=sent p/ notifications channel='in_app' (W13 pass 168)
--
-- Análise:
-- - Default sent_status='pending' aplicado p/ TODOS canais (email/telegram/in_app)
-- - processOutbox (notification-svc) so processa channel IN ('email','telegram')
-- - in_app notifications ficam em sent_status='pending' INFINITAMENTE:
--   * Nao tem cron handler in_app (UI fetch direto via GET /api/notifications)
--   * Sem next_retry_at update -> reclaimOrphanLocks ignora
--   * Audit busca 'pending overdue' inclui in_app falsos-positivos
--
-- Estrategia:
-- 1. Trigger BEFORE INSERT que seta sent_status='sent' + sent_at=NOW()
--    quando channel='in_app'
-- 2. UPDATE rows existentes (3 in_app pending no momento) para corrigir backlog
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_notif_in_app_auto_sent ON notifications;
--   DROP FUNCTION IF EXISTS fn_notif_in_app_auto_sent();

CREATE OR REPLACE FUNCTION fn_notif_in_app_auto_sent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- channel in_app nao tem processor outbox - marca como sent na criacao
  IF NEW.channel = 'in_app' AND NEW.sent_status IS DISTINCT FROM 'sent' THEN
    NEW.sent_status := 'sent';
    NEW.sent_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notif_in_app_auto_sent ON notifications;

CREATE TRIGGER trg_notif_in_app_auto_sent
BEFORE INSERT ON notifications
FOR EACH ROW
EXECUTE FUNCTION fn_notif_in_app_auto_sent();

-- Backfill: corrige in_app pending rows existentes (3 rows no momento)
UPDATE notifications
   SET sent_status = 'sent',
       sent_at = COALESCE(sent_at, created_at)
 WHERE channel = 'in_app' AND sent_status = 'pending';
