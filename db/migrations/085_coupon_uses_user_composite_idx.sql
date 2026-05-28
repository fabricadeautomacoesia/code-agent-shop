-- Migration 085: idx composto coupon_uses (coupon_id, user_id)
-- W14 pass 352 - 2026-05-28
--
-- CONTEXTO:
-- Tabela coupons tem coluna max_uses_per_user (mig 006 linha 211) MAS endpoint
-- /orders/cart/coupon ainda NAO valida essa coluna. Implementacao futura
-- precisa query:
--   SELECT COUNT(*) FROM coupon_uses WHERE coupon_id = $1 AND user_id = $2
--
-- INDICES EXISTENTES (mig 006 linha 240-241):
-- - idx_cuses_coupon (coupon_id)          -> admin reports "uses por coupon"
-- - idx_cuses_user (user_id)              -> admin reports "coupons usados por user"
--
-- LACUNA:
-- - Lookup (coupon_id, user_id) -> PG escolhe um dos 2 idx isolated e faz BitmapAnd
--   ou Seq Scan filtrando o outro. Com 1k+ users x 100+ coupons = sub-otimo.
-- - Composto (coupon_id, user_id) cobre lookup direto O(log n).
--
-- TRADE-OFF: idx extra write em cada INSERT coupon_uses (1 por checkout).
-- Aceitavel - reads sao mais frequentes (validate-then-apply pattern).
--
-- BONUS: idx tambem cobre futura query "users que usaram cupom X" via
-- index-only scan (sem heap fetch se SELECT user_id apenas).
--
-- ROLLBACK: DROP INDEX IF EXISTS idx_cuses_coupon_user;

CREATE INDEX IF NOT EXISTS idx_cuses_coupon_user
  ON coupon_uses(coupon_id, user_id);

-- ANALYZE p/ planner update stats
ANALYZE coupon_uses;

DO $$
BEGIN
  RAISE NOTICE 'W14-pass352: idx_cuses_coupon_user created (composto p/ max_uses_per_user check)';
END $$;
