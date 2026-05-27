-- Migration 012: CORRECAO CRITICA SEGURANCA 2FA (WORKER 6)
-- BUG IDENTIFICADO:
--   AES-256-GCM exige authentication tag de 16 bytes para validar integridade do ciphertext.
--   user_two_factor armazenava apenas secret_encrypted + secret_iv, sem secret_tag.
--   Todos os 3 sites de decrypt() (login, 2fa/activate, 2fa/disable) passavam Buffer.alloc(0)
--   como tag, fazendo setAuthTag() falhar com "Invalid authentication tag length" e
--   travando completamente o fluxo de 2FA em producao.
--
-- FIX:
--   ADD COLUMN secret_tag BYTEA - tolerante (IF NOT EXISTS via DO block).
--   Codigo atualizado em 4 arquivos para salvar e ler o tag corretamente.
--
-- ATENCAO: secrets ja gravados em prod sem tag NAO sao recuperaveis - usuarios com 2FA
--   ativo precisarao desativar e reconfigurar. Como tabela tem 0 rows (audit confirmou),
--   migracao sem impacto.

DO $$ BEGIN
  ALTER TABLE user_two_factor ADD COLUMN secret_tag BYTEA;
EXCEPTION
  WHEN duplicate_column THEN NULL;
  WHEN undefined_table  THEN NULL;
END $$;

-- Limpa qualquer segredo legado nao recuperavel (tag faltando) - forca re-setup
DO $$ BEGIN
  UPDATE user_two_factor
     SET is_enabled = FALSE,
         secret_encrypted = NULL,
         secret_iv = NULL,
         secret_tag = NULL,
         disabled_at = NOW()
   WHERE secret_tag IS NULL AND is_enabled = TRUE;
EXCEPTION
  WHEN undefined_table OR undefined_column THEN NULL;
END $$;

-- Tornar secret_encrypted e secret_iv NULLABLE (ja podem estar NULL pos-limpeza)
DO $$ BEGIN
  ALTER TABLE user_two_factor ALTER COLUMN secret_encrypted DROP NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE user_two_factor ALTER COLUMN secret_iv DROP NOT NULL;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;

DO $$ BEGIN
  INSERT INTO schema_migrations (version, applied_at)
  VALUES ('012_user_2fa_auth_tag', NOW())
  ON CONFLICT (version) DO NOTHING;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
