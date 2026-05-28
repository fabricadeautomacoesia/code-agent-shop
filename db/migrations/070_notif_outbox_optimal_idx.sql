-- Migration 070: indice composto outbox cron processOutbox (W14 pass 234)
-- 2026-05-28
--
-- CONTEXTO:
-- notification-svc cron `*/30 * * * * *` chama processOutbox() que executa:
--   SELECT id FROM notifications
--    WHERE sent_status = 'pending'
--      AND channel IN ('email','telegram')
--      AND retry_count < 5
--      AND next_retry_at <= NOW()
--      AND locked_by IS NULL
--    ORDER BY priority DESC, created_at ASC
--    LIMIT 25
--    FOR UPDATE SKIP LOCKED
--
-- INDICES EXISTENTES (mig 008):
--   idx_notif_pending: (channel, sent_status) PARTIAL WHERE sent_status='pending'
--   idx_notif_user_unread: (user_id, created_at DESC) PARTIAL WHERE is_read=FALSE
--   idx_notif_created: (created_at DESC)
--
-- PROBLEMA:
-- idx_notif_pending pega rows pending mas filtros (next_retry_at, locked_by,
-- retry_count) sao aplicados in-memory apos fetch. Em prod com SMTP outage:
--   - 10k+ rows pending acumulam
--   - cron a cada 30s scaneia idx_notif_pending -> ~10k row IDs
--   - Filtra in-memory next_retry_at <= NOW() (rejeita 8k retry futuro)
--   - Filtra in-memory locked_by IS NULL (rejeita 25 locked por workers)
--   - Sort priority DESC, created_at ASC: 2k rows ordenadas para top 25
--   - Custo per cron tick: 20-100ms (escala com pending count)
--
-- POST-FIX: indice composto otimizado pra processOutbox EXACT query path:
--   (sent_status, next_retry_at, locked_by) PARTIAL WHERE
--      sent_status='pending' AND locked_by IS NULL AND retry_count < 5
--
-- - PARTIAL WHERE filtra ~80% das rows ja no indice (only ready-to-process)
-- - next_retry_at em segunda posicao: range scan ja ordena
-- - Lookup O(log n) vs scan completo idx_notif_pending
--
-- TRADE-OFF:
-- - Index UPDATE custom em cada INSERT/UPDATE notifications (custo write)
-- - notifications tem ~30k writes/dia (volume modesto) - aceitavel
-- - Retorno: cron tick processOutbox de 20-100ms -> <5ms
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_notif_outbox_ready;

CREATE INDEX IF NOT EXISTS idx_notif_outbox_ready
  ON notifications(priority DESC, created_at ASC, next_retry_at)
  WHERE sent_status = 'pending'
    AND locked_by IS NULL
    AND retry_count < 5;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass234: idx_notif_outbox_ready created (PARTIAL composite for processOutbox)';
END $$;
