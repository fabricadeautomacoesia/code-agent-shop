-- Migration 076: indice funcional UPPER(code) em coupons
-- W14 pass 260 - 2026-05-28
--
-- CONTEXTO:
-- coupons.code VARCHAR(40) UNIQUE - PK acessivel via case-sensitive lookup
-- MAS endpoint /orders/cart/coupon/:code/preview e /coupon:
--   SELECT ... WHERE UPPER(code) = UPPER($1)
-- (pass 16 W7 case-insensitive lookup p/ UX)
--
-- PROBLEMA:
-- UNIQUE(code) existing nao serve UPPER() lookup
-- PG precisa Seq Scan da tabela coupons inteira p/ aplicar UPPER funcional
-- - 100 coupons hoje: ~5ms scan OK
-- - 10k coupons (1 ano prod com campanhas): ~50-200ms
-- - User digitando cupom no checkout (debounce 300ms) hit cache 30s, miss = 50ms+
--
-- POST-FIX: indice funcional EXPRESSION (UPPER(code))
-- - PG usa idx para WHERE UPPER(code) = UPPER($1) direto
-- - Lookup O(log n) vs O(n) Seq Scan
-- - Cache 30s ainda relevante (preview hot path)
--
-- TRADE-OFF: idx write em CADA UPDATE coupons (rare admin ops)
-- Aceitavel - read-heavy table.
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_coupons_code_upper;

CREATE INDEX IF NOT EXISTS idx_coupons_code_upper
  ON coupons(UPPER(code));

DO $$
BEGIN
  RAISE NOTICE 'W14-pass260: idx_coupons_code_upper created (functional UPPER idx)';
END $$;
