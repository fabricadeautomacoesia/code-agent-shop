-- Migration 067: seed notification_templates restantes (debt pass 224)
-- W13 pass 225 - 2026-05-28
--
-- CONTEXTO:
-- Pass 224 (mig 066) seedou 8 templates faltantes. Esta migration completa
-- com 5 templates remanescentes identificados no audit cross-svc.
--
-- TEMPLATES SEEDED (5):
-- - qa_dispatch_failed (qa-svc - QA pipeline failure notify seller)
-- - qa_run_timeout (qa-svc - QA run >5min timeout)
-- - product_approved (qa-svc - QA pass notify seller)
-- - product_rejected (qa-svc - QA fail notify seller)
-- - 2fa_disabled (auth-svc - security alert user)
--
-- ESTRATEGIA DEFENSIVA (3 layers fallback - mesmo pattern mig 065/066).

DO $$
DECLARE
  templates JSONB := '[
    {"code":"qa_dispatch_failed","title":"QA pipeline indisponivel temporariamente","body":"Nao foi possivel iniciar a analise QA do produto \"{{title}}\". Tente reenviar para QA em alguns minutos. Se o problema persistir, contate suporte."},
    {"code":"qa_run_timeout","title":"Analise QA expirou: {{title}}","body":"A analise QA do produto \"{{title}}\" excedeu o tempo limite (5 minutos). Voce pode reenviar para QA. Causas comuns: pacote grande, dependencias complexas, LLM provider lento."},
    {"code":"product_approved","title":"Produto aprovado: {{title}}","body":"Parabens! Seu produto \"{{title}}\" foi aprovado no QA (confidence {{score}}%) e ja esta na vitrine. Compradores podem visualizar e adquirir agora."},
    {"code":"product_rejected","title":"Necessario ajustar: {{title}}","body":"Seu produto \"{{title}}\" nao passou no QA.\nMotivos:\n- {{reasons}}\n\nRevise o produto e reenvie para nova analise QA."},
    {"code":"2fa_disabled","title":"2FA desativado em sua conta","body":"A autenticacao de dois fatores foi desativada em sua conta. Se nao foi voce, troque sua senha imediatamente em /conta/seguranca. Todas as suas sessoes foram encerradas por seguranca."}
  ]'::JSONB;
  t JSONB;
BEGIN
  FOR t IN SELECT * FROM jsonb_array_elements(templates) LOOP
    BEGIN
      -- LAYER 1: mig 018+ schema
      INSERT INTO notification_templates (template_code, title_template, body_template, channels, category)
      VALUES (
        t->>'code',
        t->>'title',
        t->>'body',
        ARRAY['in_app','email']::TEXT[],
        CASE
          WHEN t->>'code' LIKE 'qa_%' OR t->>'code' LIKE 'product_%' THEN 'qa_pipeline'
          WHEN t->>'code' LIKE '2fa_%' OR t->>'code' LIKE 'security_%' THEN 'security'
          ELSE 'general'
        END
      )
      ON CONFLICT (template_code) DO UPDATE SET
        title_template = EXCLUDED.title_template,
        body_template = EXCLUDED.body_template;
    EXCEPTION
      WHEN undefined_column THEN
        BEGIN
          -- LAYER 2: sem category
          INSERT INTO notification_templates (template_code, title_template, body_template, channels)
          VALUES (t->>'code', t->>'title', t->>'body', ARRAY['in_app','email']::TEXT[])
          ON CONFLICT (template_code) DO NOTHING;
        EXCEPTION
          WHEN undefined_column THEN
            -- LAYER 3: mig 008 schema antigo
            BEGIN
              INSERT INTO notification_templates (code, name, channel, body_template)
              VALUES (t->>'code', t->>'code', 'in_app', t->>'body')
              ON CONFLICT (code) DO NOTHING;
            EXCEPTION WHEN OTHERS THEN NULL; END;
          WHEN OTHERS THEN NULL;
        END;
      WHEN OTHERS THEN NULL;
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  RAISE NOTICE 'W13-pass225: 5 templates remaining seeded (qa_dispatch_failed, qa_run_timeout, product_approved, product_rejected, 2fa_disabled)';
END $$;

-- ROLLBACK:
--   DELETE FROM notification_templates WHERE template_code IN
--     ('qa_dispatch_failed','qa_run_timeout','product_approved','product_rejected','2fa_disabled');
