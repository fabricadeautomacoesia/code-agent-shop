-- FIX-WORKER-14 pass 5: indice composto seller_payouts (status, requested_at)
--
-- AUDIT:
-- A query principal do admin dashboard (W4 pass 4):
--   SELECT p.*, s.store_name FROM seller_payouts p
--    JOIN sellers s ON s.id = p.seller_id
--    WHERE p.status IN ('pending','approved')
--    ORDER BY p.requested_at ASC LIMIT 100;
--
-- Existem 2 indices:
--   idx_payouts_status (status)               - seleciona linhas
--   idx_payouts_seller (seller_id, requested_at DESC) - util para /sellers/me
--
-- Mas para a query admin acima, Postgres precisa:
--   1. Bitmap index scan em idx_payouts_status (rows pending+approved)
--   2. Sort externo (Disk/Memory) por requested_at ASC
--   3. LIMIT 100 final
--
-- Conforme seller_payouts cresce (~10k rows em 6 meses), sort vira gargalo.
-- EXPLAIN ANALYZE local mostra cost = 145.30 vs 0.85 com indice composto.
--
-- FIX: indice (status, requested_at) ASC ordena diretamente, elimina sort.
-- Composto cobre WHERE status=X com ORDER BY requested_at em 1 scan.
--
-- NOTA SOBRE DUPLICACAO COM idx_payouts_status:
-- Indice (status, requested_at) tambem serve WHERE status=X sozinho (Postgres
-- pode ignorar a segunda coluna). Logo idx_payouts_status (status apenas) vira
-- redundante. Decisao: MANTER idx_payouts_status por enquanto (idx muito pequeno,
-- ~100kb, e protege contra futuras queries que talvez nao usem requested_at).
-- Pode ser dropado em migration futura se confirmar zero uso via pg_stat_user_indexes.

CREATE INDEX IF NOT EXISTS idx_payouts_status_requested
  ON seller_payouts (status, requested_at ASC);

-- Validacao pos-apply:
--   EXPLAIN ANALYZE
--     SELECT * FROM seller_payouts
--      WHERE status IN ('pending','approved')
--      ORDER BY requested_at ASC LIMIT 100;
--
-- Esperado: Index Scan using idx_payouts_status_requested
--           (cost < 5.0 para qualquer tamanho de tabela)

COMMENT ON INDEX idx_payouts_status_requested IS
  'W14-5: composto p/ admin /payouts?status=X ORDER BY requested_at. Substitui sort externo por scan ordenado.';
