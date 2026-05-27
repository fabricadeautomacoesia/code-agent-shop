-- Migration 015: revocation columns para refund (WORKER 11 payment audit)
-- PAYMENT_REFUNDED webhook precisa marcar order_items como revogados
-- para impedir downloads pos-refund.

DO $$ BEGIN
  ALTER TABLE order_items ADD COLUMN revoked_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE order_items ADD COLUMN revoked_reason VARCHAR(80);
EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;

-- Index para query de license validation incluir revoked filter
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_oi_active_license ON order_items(license_key)
    WHERE revoked_at IS NULL AND download_expires_at > NOW();
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  INSERT INTO schema_migrations (version, applied_at)
  VALUES ('015_payment_refund_revocation', NOW())
  ON CONFLICT (version) DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
