-- Migration 054: ADD updated_at + trigger em coupons (W14 pass 135)
--
-- Análise:
-- - coupons table criada SEM updated_at (apenas created_at)
-- - Use cases comuns que modificam coupons:
--   * Admin extende expires_at (campanha estendida)
--   * Admin ajusta discount_value (correcao precificacao)
--   * Admin desativa is_active (desativacao manual)
--   * Sistema incrementa used_count em cada CartCoupon apply
-- - SEM updated_at -> impossivel auditar "quando admin alterou desconto"
--   ou debugging "cupom mudou tier_breakpoints sem aviso"
--
-- Pattern: 12 tabelas ja tem trigger fn_set_updated_at + user_loyalty
-- (pass 124) - coupons era proxima candidata obvia
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_coupons_updated_at ON coupons;
--   ALTER TABLE coupons DROP COLUMN IF EXISTS updated_at;

-- IF NOT EXISTS p/ idempotencia
ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();

-- Backfill rows existentes para = created_at (semantica: 'nunca modificado')
UPDATE coupons SET updated_at = created_at WHERE updated_at = NOW()::TIMESTAMPTZ;

-- Trigger reusa fn_set_updated_at existente
DROP TRIGGER IF EXISTS trg_coupons_updated_at ON coupons;
CREATE TRIGGER trg_coupons_updated_at
BEFORE UPDATE ON coupons
FOR EACH ROW
EXECUTE FUNCTION fn_set_updated_at();
