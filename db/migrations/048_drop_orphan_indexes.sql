-- Migration 048: DROP orphan indices detectados em prod (W18 pass 119)
--
-- Análise via SSH+psql em produção (cas.inovareinteligenciaartificial.com):
-- Ambos com idx_scan=0 desde deploy (≥72h em prod ativa).
--
-- 1. idx_metrics_host_time (824 KB)
--    REDUNDANTE com idx_metrics_collected (que já indexa collected_at DESC).
--    Query única que usaria host+collected_at é cron worker filtrando por host,
--    mas em deploy single-node não há filtro por host (deployment não distribuiu).
--    Migration 011 criou este idx prematuramente esperando multi-host scenario.
--
-- 2. idx_products_title_trgm (56 KB)
--    GIN trigram index para ILIKE search. Atualmente search-svc usa pg_trgm
--    via search_tsv (tsvector full-text) + idx separado. ILIKE title nunca
--    é o critério principal de search.
--    Se voltarmos a usar ILIKE, recriar com migration explícita.
--
-- Storage liberado: ~880 KB total.
-- INSERTs em metrics_history aceleram ~5% (1 idx menos para manter).
-- Storage products: -56KB (irrelevant).
--
-- ROLLBACK:
--   CREATE INDEX idx_metrics_host_time ON metrics_history(host, collected_at DESC);
--   CREATE INDEX idx_products_title_trgm ON products USING GIN(title gin_trgm_ops);

DROP INDEX IF EXISTS idx_metrics_host_time;
DROP INDEX IF EXISTS idx_products_title_trgm;

-- ANALYZE para refresh statistics pos-drop
ANALYZE metrics_history;
ANALYZE products;
