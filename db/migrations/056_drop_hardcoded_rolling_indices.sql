-- Migration 056: DROP indices product_views com timestamp HARDCODED (W18 pass 144)
--
-- Análise:
-- - idx_pviews_rolling_30d WHERE created_at > '2026-05-05 00:00:00+00'
-- - idx_pviews_rolling_90d WHERE created_at > '2026-03-06 00:00:00+00'
-- - ANTI-PATTERN: timestamps hardcoded ficam obsoletos com tempo
-- - idx_scan=0 em ambos = NUNCA USADOS desde criacao (~3-4 semanas)
--
-- Causa do nao-uso:
-- - Queries normalmente filtram WHERE created_at > NOW() - INTERVAL 'N days'
-- - Planner nao consegue match com partial WHERE timestamptz LITERAL
-- - PG planner aceita partial WHERE com IMMUTABLE expressions, mas NOW() e STABLE
--
-- Estrategia:
-- - DROP ambos (zero uso confirmado)
-- - Substituidos por idx_pviews_user_recent (ja existe, partial WHERE user_id IS NOT NULL)
--   que cobre as queries time-window usando filter pos-Index Scan
-- - Storage liberado: ~50KB (provavel - tabela tinha apenas 89 rows)
--
-- ROLLBACK (se reverter):
--   CREATE INDEX idx_pviews_rolling_30d ... -- pode usar NOW() em vez de literal

DROP INDEX IF EXISTS idx_pviews_rolling_30d;
DROP INDEX IF EXISTS idx_pviews_rolling_90d;

ANALYZE product_views;
