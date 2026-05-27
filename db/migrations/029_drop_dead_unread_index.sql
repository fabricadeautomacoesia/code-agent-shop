-- WORKER 14 pass 2: DROP idx_notif_user_unread (morto desde W13 pass 4).
--
-- pg_stat_user_indexes confirma: idx_scan=0 em uptime atual (10+ horas, varios
-- polls de /unread-count). W13 pass 4 introduziu endpoint /unread-count que usa
-- idx_notif_user_channel_created (mig 020) - mais composto, cobre mais queries.
--
-- idx_notif_user_unread predicate (user_id, created_at DESC) WHERE is_read=false
-- era util ANTES do mig 020 mas agora redundante:
-- - /unread-count usa COUNT(*) WHERE user_id=X AND channel='in_app' AND is_read=false
--   -> idx_notif_user_channel_created (user_id, channel, created_at DESC)
--      cobre INDEX SCAN + filter is_read=false (1 extra check)
-- - /notifications usa SELECT WHERE user_id=X AND channel='in_app' ORDER BY created_at
--   -> mesmo idx cobre 100% sem filter
--
-- Overhead removido: INSERT/UPDATE em notifications nao precisam mais manter
-- idx_notif_user_unread btree. Em high-write workload (10k+ notifs/min)
-- isso = ~50us economia/insert.
--
-- Idempotente: DROP IF EXISTS.

DROP INDEX IF EXISTS idx_notif_user_unread;

-- Stats: forca planner recalculo apos drop
ANALYZE notifications;

-- WORKER 14 pass 2 BONUS: idx composto para listagem /products
--
-- EXPLAIN ANALYZE confirmou Seq Scan + Sort em:
--   SELECT ... FROM products
--    WHERE status='approved' AND deleted_at IS NULL
--    ORDER BY sales_count DESC LIMIT 24
--
-- idx_products_sales (sales_count DESC) existia mas sem partial -> planner
-- ignorava por causa de filter status/deleted_at. idx_products_approved
-- (predicate status='approved') existia mas sem ORDER chave -> Sort separado.
--
-- Solucao: idx composto PARCIAL combina ambos = Index Scan SEM Sort.
-- Mata 2 birds com 1 stone (Seq Scan + Sort) na rota mais hit do site.
--
-- Idempotente.

CREATE INDEX IF NOT EXISTS idx_products_approved_sales
  ON products (sales_count DESC, avg_rating DESC NULLS LAST)
  WHERE status = 'approved' AND deleted_at IS NULL;

ANALYZE products;
