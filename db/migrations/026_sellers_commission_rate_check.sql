-- Migration 026: CHECK constraint custom_commission_rate (WORKER 11 pass 3)
-- =====================================================================
-- PROBLEMA:
-- sellers.custom_commission_rate (NUMERIC, nullable) sem CHECK constraint.
-- Admin podia setar valor > 1.0 (>100%) ou negativo:
--   custom_commission_rate = 1.5 -> commission = 150% line_total
--   -> payout_cents = line_total - 1.5*line_total = -0.5*line_total
--   -> seller fica DEVENDO a plataforma (negativo)
-- Mesma falha do lado oposto: custom_commission_rate = -0.18 -> seller
-- recebe MAIS que line_total (overcharge da plataforma).
--
-- FIX em order-svc/orders.js linha 84 ja faz clamp 0..1 em JS (defense layer 1).
-- Esta migration adiciona DB-level constraint (defense layer 2).
-- =====================================================================
DO $$ BEGIN
  ALTER TABLE sellers
    ADD CONSTRAINT chk_sellers_commission_rate
    CHECK (custom_commission_rate IS NULL OR (custom_commission_rate >= 0 AND custom_commission_rate <= 1));
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN check_violation THEN
    -- Se ja existe row violating, log warning + skip constraint
    RAISE WARNING 'Cannot add CHECK chk_sellers_commission_rate: existing rows violate (custom_commission_rate < 0 ou > 1). Fix data first.';
  WHEN undefined_table THEN NULL;
END $$;
