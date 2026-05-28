-- Migration 064: comment-only marker - cache invalidation strategy
-- W18 pass 212 - 2026-05-28
--
-- CONTEXTO:
-- Cache `notifs:unread-count:{userId}` 20s TTL adicionado em pass 212
-- (notification-svc). Invalidation paths:
--
--   1. POST /:id/read       (in-svc invalidate - implementado)
--   2. POST /read-all       (in-svc invalidate - implementado)
--   3. INSERT notification  (CROSS-SVC: qa-svc, order-svc, payment-svc,
--      seller-svc, review-svc inserem notifications channel='in_app')
--
-- DESAFIO INVALIDATION (3):
-- Cross-svc cache invalidation = chamadas Redis del distribuidas em N svcs.
-- Cada svc precisaria importar cache + adicionar cache.del em CADA INSERT
-- notifications WHERE channel='in_app'.
--
-- TRADE-OFF ESCOLHIDO:
-- TTL curto 20s (vs 60s padrao) ACEITA stale window 20s.
-- NotificationBell badge atualiza em 20s apos receber notif (acceptable UX).
-- Alternativa WebSocket/SSE seria ideal mas eh refactor maior - futuro.
--
-- DOCUMENTACAO neste migration apenas para FUTURE-PROOFING:
-- Se future-iter adicionar real-time invalidation via NOTIFY/LISTEN,
-- usar esta migration como anchor point.

-- ============================================================
-- OPCIONAL FUTURE: PG NOTIFY trigger em notifications INSERT
-- ============================================================
-- Habilitar para real-time invalidation cross-svc sem importar cache em cada svc.
-- Cada svc Node.js que precisa observar pode usar pg client LISTEN.
--
-- Por ora, descomentado - TTL 20s eh suficiente UX.
-- Uncomment + apply quando WebSocket/SSE noti delivery implementado.

-- CREATE OR REPLACE FUNCTION fn_notif_unread_invalidate_notify()
-- RETURNS trigger LANGUAGE plpgsql AS $$
-- BEGIN
--   IF NEW.channel = 'in_app' AND NEW.is_read = FALSE THEN
--     PERFORM pg_notify('notifs_unread_invalidate', NEW.user_id::TEXT);
--   END IF;
--   RETURN NEW;
-- END $$;
--
-- DROP TRIGGER IF EXISTS trg_notif_unread_invalidate ON notifications;
-- CREATE TRIGGER trg_notif_unread_invalidate
--   AFTER INSERT ON notifications
--   FOR EACH ROW EXECUTE FUNCTION fn_notif_unread_invalidate_notify();

DO $$
BEGIN
  RAISE NOTICE 'W18-pass212: migration documentational only. cache invalidation strategy doc.';
  RAISE NOTICE 'TTL 20s acceptable trade-off vs cross-svc invalidate complexity.';
  RAISE NOTICE 'Real-time invalidation futuro via PG NOTIFY trigger (uncomment block).';
END $$;
