-- Migration 050: ADD trigger updated_at em user_loyalty (W14 pass 124)
--
-- Análise: 13 tabelas tem coluna updated_at, mas 12 tem trigger fn_set_updated_at,
-- restando APENAS user_loyalty SEM trigger. Sem trigger, updated_at NUNCA muda apos
-- INSERT inicial - dificulta auditoria "quando o usuario ganhou pontos pela ultima vez"
-- e debugging de bugs no fluxo loyalty.
--
-- Tabelas COM trigger (12): carts, categories, disputes, notification_templates,
--   orders, product_qna, product_reviews, products, sellers, user_two_factor,
--   users, vault_api_keys
--
-- Tabela SEM trigger (1): user_loyalty
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_loyalty_updated_at ON user_loyalty;

-- DROP defensive (re-aplicacao idempotente)
DROP TRIGGER IF EXISTS trg_loyalty_updated_at ON user_loyalty;

CREATE TRIGGER trg_loyalty_updated_at
BEFORE UPDATE ON user_loyalty
FOR EACH ROW
EXECUTE FUNCTION fn_set_updated_at();
