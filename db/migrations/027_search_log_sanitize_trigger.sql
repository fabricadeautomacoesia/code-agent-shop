-- WORKER 10 pass 4 (gap pass 3): sanitiza query_normalized BEFORE INSERT
-- na search_log. Defesa em FONTE (vs filter na SAIDA do /trending).
--
-- Estrategia: NAO BLOQUEAR insert (forensica precisa do log cru em 'query'),
-- mas NORMALIZA o campo 'query_normalized' que e o usado para trending/agg.
-- query (raw) -> mantem o original para SIEM/auditoria
-- query_normalized -> '' se contem chars perigosos (SQLi/XSS) -> exclui de trends
--
-- Tolerancia a falha: DROP IF EXISTS, CREATE OR REPLACE. Idempotente.

DO $$
BEGIN
  -- Drop trigger antigo se existir (re-run safe)
  IF EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_search_log_sanitize'
  ) THEN
    DROP TRIGGER trg_search_log_sanitize ON search_log;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'trigger drop ignored: %', SQLERRM;
END $$;

CREATE OR REPLACE FUNCTION fn_search_log_sanitize()
RETURNS TRIGGER AS $$
BEGIN
  -- Se query_normalized contem char perigoso (SQLi/XSS) OU eh muito curta
  -- (1-2 chars = lixo), SETAR como '' (vazio).
  -- Endpoint /trending ja filtra query_normalized != '' -> exclui da agg.
  --
  -- query (raw original) PRESERVA inteiro para forensica.
  IF NEW.query_normalized IS NOT NULL THEN
    -- Char perigoso: aspas, html, sql comment, semicolon, backslash
    IF NEW.query_normalized ~ '[''"<>;\\]'
       OR NEW.query_normalized ILIKE '%--%'
       OR NEW.query_normalized ILIKE '%/*%'
       OR CHAR_LENGTH(NEW.query_normalized) < 3 THEN
      NEW.query_normalized := '';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_search_log_sanitize
  BEFORE INSERT OR UPDATE ON search_log
  FOR EACH ROW
  EXECUTE FUNCTION fn_search_log_sanitize();

-- Backfill: limpa query_normalized de rows ja existentes que tem chars perigosos
-- Idempotente: condiciona a chars OU comprimento < 3
UPDATE search_log
   SET query_normalized = ''
 WHERE query_normalized IS NOT NULL
   AND query_normalized != ''
   AND (
     query_normalized ~ '[''"<>;\\]'
     OR query_normalized ILIKE '%--%'
     OR query_normalized ILIKE '%/*%'
     OR CHAR_LENGTH(query_normalized) < 3
   );
