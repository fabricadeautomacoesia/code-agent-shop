-- ============================================================
-- Migration 045: seller_status enum + KYC fields
-- FIX-WORKER-7 pass 41: compliance critical - separar SUBMIT KYC de APPROVE.
-- ============================================================
-- CONTEXTO:
--   Pre-fix endpoint /kyc setava status='active' DIRETO apos submit.
--   = compliance break critical:
--   - Seller submete KYC fake -> status='active' auto
--   - Pass 40 libera /payout p/ sellers active
--   - COMBO: seller fake submete KYC -> saca tudo
--
-- PATTERN CORRETO:
--   pending_kyc -> kyc_submitted -> [admin review] -> active|kyc_rejected
--
-- Mig 001 ja tem enum seller_status com 'pending_kyc' e 'active'.
-- Adicionar valores intermediarios kyc_submitted + kyc_rejected.
-- ============================================================

-- 1. ADD enum values novos (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumtypid = 'seller_status'::regtype
       AND enumlabel = 'kyc_submitted'
  ) THEN
    ALTER TYPE seller_status ADD VALUE 'kyc_submitted' BEFORE 'active';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
     WHERE enumtypid = 'seller_status'::regtype
       AND enumlabel = 'kyc_rejected'
  ) THEN
    ALTER TYPE seller_status ADD VALUE 'kyc_rejected' AFTER 'kyc_submitted';
  END IF;
END $$;

-- 2. ADD COLUMN kyc_submitted_at (forense tracking)
ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMPTZ;
ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS kyc_reviewed_at TIMESTAMPTZ;
ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS kyc_reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sellers
  ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT;

COMMENT ON COLUMN sellers.kyc_submitted_at IS
  'FIX-W7-41: timestamp do submit KYC pelo seller. NULL = nunca submeteu.';
COMMENT ON COLUMN sellers.kyc_reviewed_at IS
  'FIX-W7-41: timestamp do review admin (approve OR reject).';
COMMENT ON COLUMN sellers.kyc_reviewed_by_user_id IS
  'FIX-W7-41: admin/staff user_id que revisou o KYC.';
COMMENT ON COLUMN sellers.kyc_rejection_reason IS
  'FIX-W7-41: motivo da rejeicao (visivel ao seller p/ correcao).';

-- 3. UNIQUE document_number_hash (anti-fraud - 1 doc por seller)
-- ANTES: dois sellers podiam ter mesmo CPF hash sem detectar
-- AGORA: enforce 1 unique seller por documento
CREATE UNIQUE INDEX IF NOT EXISTS uq_sellers_document_number_hash
  ON sellers(document_number_hash)
  WHERE document_number_hash IS NOT NULL;

COMMENT ON INDEX uq_sellers_document_number_hash IS
  'FIX-W7-41: 1 documento (CPF/CNPJ hash) = 1 seller. Anti-fraud multi-account.';

-- 4. PARTIAL IDX admin KYC queue
CREATE INDEX IF NOT EXISTS idx_sellers_kyc_review_queue
  ON sellers(kyc_submitted_at ASC)
  WHERE status = 'kyc_submitted';

COMMENT ON INDEX idx_sellers_kyc_review_queue IS
  'FIX-W7-41: admin queue priorizada por ordem submit (FIFO triage KYC).';
