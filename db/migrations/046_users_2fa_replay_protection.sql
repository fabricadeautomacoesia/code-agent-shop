-- ============================================================
-- Migration 046: user_two_factor 2FA replay attack protection
-- FIX-WORKER-7 pass 49: RFC 6238 §5.2 compliance - TOTP nao pode ser
-- reutilizado dentro da time-step window.
-- ============================================================
-- CONTEXTO:
--   Pre-fix /login: authenticator.check(totp, secret) retorna true para
--   QUALQUER TOTP valido dentro da window 30s (default RFC 6238).
--   Sem tracking de TOTPs ja usados -> atacante:
--   1. Sniff TOTP de network/keylogger/screen-share
--   2. Replay mesmo TOTP em < 30s -> login bypass 2FA
--
--   RFC 6238 §5.2 explicit:
--   "The verifier MUST NOT accept the second attempt of the OTP after
--    the successful validation has been issued for the first OTP"
--
-- IMPLEMENTACAO:
--   Track ultimo TOTP (hash sha256) + timestamp em user_two_factor table.
--   Login compara: se mesmo hash usado < 60s atras -> reject 'totp_replay'.
--   60s = 2x window (margem segurança - clock drift + check window=1 step).
-- ============================================================

ALTER TABLE user_two_factor
  ADD COLUMN IF NOT EXISTS last_totp_hash VARCHAR(64);  -- sha256 hex
ALTER TABLE user_two_factor
  ADD COLUMN IF NOT EXISTS last_totp_used_at TIMESTAMPTZ;

COMMENT ON COLUMN user_two_factor.last_totp_hash IS
  'FIX-W7-49: sha256 hex do ultimo TOTP usado com sucesso. Anti-replay RFC 6238.';
COMMENT ON COLUMN user_two_factor.last_totp_used_at IS
  'FIX-W7-49: timestamp do ultimo TOTP usado. Replay window = 60s (2x time-step).';

-- Partial idx p/ admin audit users 2FA active (sellers ativos com 2FA)
CREATE INDEX IF NOT EXISTS idx_2fa_last_used
  ON user_two_factor(last_totp_used_at DESC)
  WHERE is_enabled = TRUE;

COMMENT ON INDEX idx_2fa_last_used IS
  'FIX-W7-49: partial idx p/ admin audit users 2FA. Detecta dormant accounts.';
