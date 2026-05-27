-- FIX-WORKER-12 pass 5: reset sellers.total_products_active inflado historico
--
-- CONTEXTO (vide W12 pass 4):
-- qa-svc callback handler em /qa/callback executava UPDATE sellers SET
-- total_products_active = total_products_active + 1 a CADA QA approved,
-- INDEPENDENTE de transicao de estado. QA roda multiplas vezes no mesmo
-- produto (v1, v2, v3...) -> counter inflava monotonicamente.
--
-- W12 pass 4 corrigiu a logica forward (so incrementa em transicao real,
-- decrementa quando approved->rejected) mas counters historicos ja estavam
-- errados.
--
-- ESTA MIGRATION reseta o counter para o COUNT(*) real do estado atual:
--   total_products_active = COUNT(produtos com status='approved' do seller)
--
-- IDEMPOTENTE: pode rodar varias vezes, sempre converge para valor correto.
--
-- VALIDACAO PRE-APPLY (executar em transaction separada para auditar):
--   SELECT
--     s.store_name,
--     s.total_products_active AS counter_atual,
--     COUNT(p.id) FILTER (WHERE p.status='approved' AND p.deleted_at IS NULL) AS real,
--     s.total_products_active - COUNT(p.id) FILTER (WHERE p.status='approved' AND p.deleted_at IS NULL) AS gap
--   FROM sellers s
--   LEFT JOIN products p ON p.seller_id = s.id
--   GROUP BY s.id, s.store_name, s.total_products_active
--   HAVING s.total_products_active <> COUNT(p.id) FILTER (WHERE p.status='approved' AND p.deleted_at IS NULL)
--   ORDER BY ABS(s.total_products_active - COUNT(p.id) FILTER (WHERE p.status='approved' AND p.deleted_at IS NULL)) DESC;
--
-- Para cada seller com gap > 0: counter inflado (mais bugs forward que decrementos).
-- Para cada seller com gap < 0: counter sub-contado (raro mas possivel se pass 4
-- nao decrementou approved->rejected antes do fix).

-- LOG + reset em bloco unico DO $$ para GET DIAGNOSTICS funcionar:
-- (DIAGNOSTICS so vale para statement imediatamente anterior no mesmo bloco)
DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  UPDATE sellers s SET
    total_products_active = COALESCE((
      SELECT COUNT(*) FROM products p
       WHERE p.seller_id = s.id
         AND p.status = 'approved'
         AND p.deleted_at IS NULL
    ), 0),
    updated_at = NOW()
  WHERE s.total_products_active <> COALESCE((
    SELECT COUNT(*) FROM products p
     WHERE p.seller_id = s.id
       AND p.status = 'approved'
       AND p.deleted_at IS NULL
  ), 0);
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RAISE NOTICE 'W12-5: % sellers tiveram total_products_active corrigido', affected_count;
END $$;

-- COMMENT: NAO criar trigger para manter o counter sincronizado.
-- Razoes:
-- 1. Trigger em product.status UPDATE acrescentaria overhead em TODAS escritas
--    (vs pontual no callback QA)
-- 2. qa-svc callback ja sabe quando counter deve mudar (pass 4 logica correta)
-- 3. archived/deleted via admin/seller dashboards: pass 6 roadmap (W12)
-- 4. Migration de reset (esta) basta como rede de seguranca anual/quarterly
