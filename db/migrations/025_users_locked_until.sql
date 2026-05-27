-- Migration 025: users.locked_until column (WORKER 17 pass 4 SECURITY)
-- =====================================================================
-- PROBLEMA:
-- Coluna users.failed_login_count incrementa em cada login falho mas
-- NUNCA e usada para travar conta. Atacante via botnet/proxies pode
-- bypass fail2ban per-IP e brute-forcear o mesmo email indefinidamente.
--
-- Confirmado em prod: admin fabricadeautomacoes0@gmail.com com
-- failed_login_count = 6 (do audit anterior) e a conta NAO foi travada.
--
-- SOLUCAO:
-- Coluna locked_until + check no /login: se locked_until > NOW(), nega
-- com 423 account_locked + mensagem do tempo restante. Reset apos sucesso.
-- =====================================================================
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- Index para queries de cleanup / unlock automatico
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_users_locked_until ON users(locked_until)
    WHERE locked_until IS NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
