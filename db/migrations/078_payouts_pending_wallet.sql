-- Migration 078: payouts_pending_wallet table p/ split fallback queue
-- W11 pass 270 - 2026-05-28
--
-- CONTEXTO (pass 268 identified):
-- order-svc INSERT asaas_splits so se !is_platform_owned && asaas_wallet_id && payout>0
-- Seller sem KYC/wallet config: payout 100% vai p/ wallet plataforma (perda receita seller)
-- Sem queue p/ reconciliar quando seller depois configura asaas_wallet_id
--
-- USE CASE:
-- 1. Order paga via Asaas (split sem seller A pq A sem wallet)
-- 2. INSERT payouts_pending_wallet row (debt da plataforma p/ seller A)
-- 3. Seller A configura asaas_wallet_id em /sellers/me/kyc
-- 4. Cron diario detecta seller now-has-wallet -> Asaas createTransfer + UPDATE 'paid'
-- 5. Notification "Voce tem X em payouts pendentes liquidados"
--
-- SCHEMA:
-- - order_id REFERENCES orders (CASCADE delete se order rejeitado/expired)
-- - seller_id REFERENCES sellers (CASCADE)
-- - amount_cents BIGINT (valor devido)
-- - status pending|liquidated|forfeited (cancelado se seller deleta conta)
-- - created_at + liquidated_at p/ audit
--
-- IDX:
-- - (seller_id, status) PARTIAL WHERE status='pending' - cron lookup
-- - (order_id) - cascade tracking
--
-- ROLLBACK: DROP TABLE payouts_pending_wallet;

CREATE TABLE IF NOT EXISTS payouts_pending_wallet (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id   UUID REFERENCES order_items(id) ON DELETE CASCADE,
    seller_id       UUID NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
    amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','liquidated','forfeited')),
    reason          VARCHAR(100) DEFAULT 'no_asaas_wallet',  -- why deferred
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    liquidated_at   TIMESTAMPTZ,                              -- when seller config wallet + cron processed
    asaas_transfer_id VARCHAR(60),                            -- Asaas transfer id apos liquidacao
    forfeited_at    TIMESTAMPTZ,                              -- account deleted / forfeit
    forfeited_reason TEXT
);

-- Indices p/ cron hot-path (detect seller now-has-wallet)
CREATE INDEX IF NOT EXISTS idx_pending_wallet_seller_pending
  ON payouts_pending_wallet(seller_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pending_wallet_order
  ON payouts_pending_wallet(order_id);

CREATE INDEX IF NOT EXISTS idx_pending_wallet_created
  ON payouts_pending_wallet(created_at DESC);

COMMENT ON TABLE payouts_pending_wallet IS
  'Debt queue: seller sem asaas_wallet_id durante checkout. Cron diario liquidates quando wallet configurada.';

DO $$
BEGIN
  RAISE NOTICE 'W11-pass270: payouts_pending_wallet table created (split fallback queue)';
END $$;
