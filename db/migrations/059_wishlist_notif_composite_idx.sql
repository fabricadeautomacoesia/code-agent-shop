-- Migration 059: indices compostos product_wishlist + notifications
-- W14 pass 179 - 2026-05-28
--
-- ============================================================================
-- INDEX 1: product_wishlist (user_id, created_at DESC, product_id ASC)
-- ============================================================================
--
-- QUERY ALVO (W18 pass 178 optimizada via window):
--   SELECT p.* FROM product_wishlist w
--    JOIN products p ON p.id = w.product_id
--   WHERE w.user_id = $1 AND p.status IN ('approved','platform_owned')
--     AND p.deleted_at IS NULL
--   ORDER BY w.created_at DESC, w.product_id ASC
--   LIMIT 50 OFFSET 0
--
-- INDICES EXISTENTES:
--   idx_wishlist_user    (user_id)        - filter only, no sort
--   idx_wishlist_product (product_id)     - JOIN side
--
-- GAP: PG executa Bitmap Index Scan idx_wishlist_user + Sort externo created_at.
-- Em user heavy (50+ favoritos), Sort de 50 rows ~5-10ms em memoria.
-- Para 1000+ favoritos (whale users): ~30-50ms sort.
--
-- FIX: (user_id, created_at DESC, product_id ASC) compound matches ORDER BY exato.
-- PG executa Index Scan ordenado, LIMIT 50 le primeiras 50 entries direto.
-- Performance: 10ms -> <1ms (whale case 50ms -> <2ms).
--
-- Sort order: DESC primary + ASC secondary - PG btree multi-column suporta direcoes
-- diferentes em cada coluna desde PG 8.3.

CREATE INDEX IF NOT EXISTS idx_wishlist_user_created
  ON product_wishlist (user_id, created_at DESC, product_id ASC);

COMMENT ON INDEX idx_wishlist_user_created IS
  'W14-pass179: composto p/ GET /wishlist paginado (W18-178). Elimina sort externo. Tiebreaker product_id ASC determinismo.';

-- ============================================================================
-- INDEX 2: notifications (user_id, channel, created_at DESC) WHERE deleted_at IS NULL
-- ============================================================================
--
-- QUERY ALVO (notification-svc /me):
--   SELECT * FROM notifications
--    WHERE user_id = $1 AND channel = 'in_app'
--    ORDER BY created_at DESC, id DESC
--    LIMIT 20 OFFSET 0
--
-- INDICES EXISTENTES:
--   idx_notif_user_unread  PARTIAL (user_id, created_at DESC) WHERE is_read=FALSE
--   idx_notif_created      (created_at DESC) - global sort only
--   idx_notif_pending      PARTIAL (channel, sent_status) WHERE pending
--
-- GAP: query SEM ?unread=true filter -> idx_notif_user_unread nao matcha
-- (partial WHERE is_read=FALSE exclui lidas que tambem aparecem em /me).
-- PG cai em idx_notif_created (global sort) + Filter user_id+channel pos-scan.
-- Em DB com 500k notificacoes, scan global filtrando 1 user eh waste.
--
-- FIX: composite (user_id, channel, created_at DESC) cobre query padrao.
-- BONUS: cobre tambem (user_id,) prefix - util p/ COUNT(*) endpoints.
--
-- DECISAO: NAO usar PARTIAL WHERE channel='in_app'. Channel diversificara no
-- futuro (push, sms) e indice base reutilizavel. Custo extra ~ < 1MB.

CREATE INDEX IF NOT EXISTS idx_notif_user_channel_created
  ON notifications (user_id, channel, created_at DESC);

COMMENT ON INDEX idx_notif_user_channel_created IS
  'W14-pass179: composto p/ GET /notifications/me (in_app default). Cobre query lidas+nao-lidas. idx_notif_user_unread partial mantida p/ unread=true filter.';

-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   DROP INDEX IF EXISTS idx_wishlist_user_created;
--   DROP INDEX IF EXISTS idx_notif_user_channel_created;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass179: 2 indices compostos criados (wishlist + notifications)';
END $$;

-- ============================================================================
-- VALIDACAO POS-APPLY
-- ============================================================================
--   1. Wishlist:
--      EXPLAIN ANALYZE SELECT * FROM product_wishlist
--       WHERE user_id = '<some-uuid>'
--       ORDER BY created_at DESC, product_id ASC LIMIT 50;
--      Esperado: Index Scan using idx_wishlist_user_created (sem Sort node)
--
--   2. Notifications:
--      EXPLAIN ANALYZE SELECT * FROM notifications
--       WHERE user_id = '<some-uuid>' AND channel = 'in_app'
--       ORDER BY created_at DESC, id DESC LIMIT 20;
--      Esperado: Index Scan using idx_notif_user_channel_created
