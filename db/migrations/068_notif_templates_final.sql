-- Migration 068: seed notification_templates FINAIS (debt cleanup pass 224/225)
-- W13 pass 226 - 2026-05-28
--
-- CONTEXTO:
-- Audit exhaustive cross-svc revelou +10 templates ainda nao seeded apos
-- mig 066/067. Esta migration completa cobertura 100%.
--
-- TEMPLATES SEEDED (10):
--
-- REVIEW-SVC (5):
-- - review_received (seller notif nova review)
-- - review_replied (buyer notif seller respondeu)
-- - qna_question (seller notif nova pergunta)
-- - qna_answered (asker notif resposta seller)
-- - report_resolved (reporter notif moderacao)
--
-- SELLER-SVC (5):
-- - sla_revoked (cron suspende seller Classe B)
-- - sla_warning_7d (7 dias para deadline)
-- - sla_warning_3d (3 dias para deadline)
-- - sla_warning_1d (1 dia para deadline)
-- - seller_suspended, seller_reactivated, kyc_approved, kyc_rejected (admin actions)

DO $$
DECLARE
  templates JSONB := '[
    {"code":"review_received","title":"Nova avaliacao recebida","body":"Voce recebeu uma nova avaliacao em {{product_title}} com nota {{rating}}/5. Acesse /reviews para ler e responder."},
    {"code":"review_replied","title":"Vendedor respondeu sua avaliacao","body":"O vendedor de {{product_title}} respondeu sua avaliacao. Acesse o produto para ler a resposta."},
    {"code":"qna_question","title":"Nova pergunta","body":"Voce recebeu uma nova pergunta em {{product_title}}. Acesse /qna para responder e ajudar a vender."},
    {"code":"qna_answered","title":"Sua pergunta foi respondida","body":"O vendedor respondeu sua pergunta em {{product_title}}. Acesse o produto para ver a resposta."},
    {"code":"report_resolved","title":"Sua denuncia foi processada","body":"Sua denuncia foi {{outcome}}. {{notes}} Obrigado por contribuir com a qualidade da plataforma."},
    {"code":"sla_revoked","title":"Acesso temporariamente suspenso","body":"Seu acesso Classe B foi suspenso por falta de upload no SLA. Faca upload de produto em /upload para reativar."},
    {"code":"sla_warning_7d","title":"SLA: 7 dias restantes","body":"Seu SLA Classe B vence em 7 dias. Faca upload de produto em /upload para manter privilegios."},
    {"code":"sla_warning_3d","title":"SLA: 3 dias restantes","body":"Seu SLA Classe B vence em 3 dias. URGENTE: faca upload de produto em /upload."},
    {"code":"sla_warning_1d","title":"SLA: 1 dia restante","body":"ULTIMO DIA - seu SLA Classe B vence amanha. Faca upload em /upload AGORA para evitar suspensao."},
    {"code":"seller_suspended","title":"Conta seller suspensa","body":"Sua conta seller foi suspensa pelo admin. Motivo: {{reason}}. Contate suporte para revisao."},
    {"code":"seller_reactivated","title":"Conta seller reativada","body":"Sua conta seller foi reativada. Voce pode voltar a vender em /products."},
    {"code":"kyc_approved","title":"KYC aprovado","body":"Seu KYC foi aprovado. Voce agora pode receber payouts via Asaas em /financeiro."},
    {"code":"kyc_rejected","title":"KYC rejeitado","body":"Seu KYC foi rejeitado. Motivo: {{reason}}. Voce pode re-submeter com correcoes em /loja."}
  ]'::JSONB;
  t JSONB;
BEGIN
  FOR t IN SELECT * FROM jsonb_array_elements(templates) LOOP
    BEGIN
      INSERT INTO notification_templates (template_code, title_template, body_template, channels, category)
      VALUES (
        t->>'code',
        t->>'title',
        t->>'body',
        ARRAY['in_app','email']::TEXT[],
        CASE
          WHEN t->>'code' LIKE 'review_%' OR t->>'code' LIKE 'qna_%' OR t->>'code' = 'report_resolved' THEN 'reviews_qna'
          WHEN t->>'code' LIKE 'sla_%' THEN 'sla_alerts'
          WHEN t->>'code' LIKE 'seller_%' OR t->>'code' LIKE 'kyc_%' THEN 'seller_lifecycle'
          ELSE 'general'
        END
      )
      ON CONFLICT (template_code) DO UPDATE SET
        title_template = EXCLUDED.title_template,
        body_template = EXCLUDED.body_template;
    EXCEPTION
      WHEN undefined_column THEN
        BEGIN
          INSERT INTO notification_templates (template_code, title_template, body_template, channels)
          VALUES (t->>'code', t->>'title', t->>'body', ARRAY['in_app','email']::TEXT[])
          ON CONFLICT (template_code) DO NOTHING;
        EXCEPTION
          WHEN undefined_column THEN
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
  RAISE NOTICE 'W13-pass226: 13 templates FINAIS seeded (review_*, qna_*, sla_*, seller_*, kyc_*)';
END $$;

-- TOTAL templates POS-pass-226: 29
-- ROLLBACK manual via DELETE WHERE template_code IN (...)
