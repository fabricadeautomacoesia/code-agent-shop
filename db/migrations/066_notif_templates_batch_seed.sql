-- Migration 066: batch seed notification_templates faltantes
-- W13 pass 224 - 2026-05-28
--
-- CONTEXTO:
-- Audit cross-svc revelou ~10 template_codes referenciados em INSERT notifications
-- mas NAO seeded em notification_templates. Resultado: mustache render falha
-- silenciosamente -> body raw com {{vars}} mostrado em UI.
--
-- TEMPLATES PRE-PASS-224 (3 ja seeded):
-- - product_new_version (mig 018)
-- - vault_rotation_due (mig 036)
-- - asaas_refund_failed (mig 065 - pass 223)
--
-- TEMPLATES SEEDED NESTA MIGRATION (8):
-- - welcome (auth-svc registro)
-- - password_reset (auth-svc forgot-password)
-- - loyalty_tier_up (loyalty.js + payment-svc)
-- - order_paid (payment-svc webhook PAYMENT_RECEIVED)
-- - order_refunded (payment-svc PAYMENT_REFUNDED)
-- - seller_new_sale (payment-svc - notify seller of new order)
-- - seller_sale_refunded (payment-svc refund - notify seller)
-- - security_refresh_reuse (auth-svc - refresh token reuse alert)
--
-- ESTRATEGIA DEFENSIVA (3 layers fallback - mesmo pattern mig 065):

DO $$
DECLARE
  templates JSONB := '[
    {"code":"welcome","title":"Bem-vindo ao Code & Agent Shop, {{name}}!","body":"Sua conta foi criada com sucesso. Explore o catalogo em https://shop.inovareinteligenciaartificial.com e ganhe 100 pontos bonus."},
    {"code":"password_reset","title":"Redefinicao de senha - Code & Agent Shop","body":"Ola {{name}}, clique no link para redefinir sua senha: {{url}}. Link expira em 15 minutos. Se nao foi voce, ignore."},
    {"code":"loyalty_tier_up","title":"Voce subiu para o tier {{tier}}!","body":"Parabens {{name}}, voce alcancou o tier {{tier}} com {{points}} pontos lifetime. Beneficios exclusivos disponiveis."},
    {"code":"order_paid","title":"Pedido confirmado - {{order_number}}","body":"Seu pedido {{order_number}} foi pago com sucesso. Acesse seus produtos em /conta/pedidos."},
    {"code":"order_refunded","title":"Reembolso processado - {{order_number}}","body":"Seu pedido {{order_number}} foi estornado. O valor sera creditado em ate 5 dias uteis (PIX/credit card). Pontos resgatados foram devolvidos. Pontos ganhos foram subtraidos."},
    {"code":"seller_new_sale","title":"Nova venda: {{product_title}}","body":"Parabens! Voce vendeu {{product_title}} para {{buyer_name}}. Valor liquido: {{net_amount}}. Acesse /financeiro para detalhes."},
    {"code":"seller_sale_refunded","title":"Venda estornada: {{product_title}}","body":"A venda do produto \"{{product_title}}\" foi estornada. Seu saldo foi ajustado. Acesse /financeiro para detalhes."},
    {"code":"security_refresh_reuse","title":"Alerta de seguranca: sessao reutilizada","body":"Detectamos uso indevido do seu refresh token. Todas as sessoes foram revogadas por seguranca. Se nao foi voce, troque sua senha em /conta/seguranca."}
  ]'::JSONB;
  t JSONB;
BEGIN
  FOR t IN SELECT * FROM jsonb_array_elements(templates) LOOP
    BEGIN
      -- LAYER 1: schema novo (mig 018+)
      INSERT INTO notification_templates (template_code, title_template, body_template, channels, category)
      VALUES (
        t->>'code',
        t->>'title',
        t->>'body',
        ARRAY['in_app','email']::TEXT[],
        CASE
          WHEN t->>'code' LIKE 'order_%' THEN 'orders'
          WHEN t->>'code' LIKE 'seller_%' THEN 'seller_alerts'
          WHEN t->>'code' LIKE 'security_%' THEN 'security'
          WHEN t->>'code' LIKE 'loyalty_%' THEN 'loyalty'
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
            -- LAYER 3: schema antigo (code,channel singular)
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
  RAISE NOTICE 'W13-pass224: 8 notification_templates seeded (welcome, password_reset, loyalty_tier_up, order_paid, order_refunded, seller_new_sale, seller_sale_refunded, security_refresh_reuse)';
END $$;

-- ROLLBACK:
--   DELETE FROM notification_templates WHERE template_code IN
--     ('welcome','password_reset','loyalty_tier_up','order_paid','order_refunded',
--      'seller_new_sale','seller_sale_refunded','security_refresh_reuse');
--   OR (schema antigo): DELETE FROM notification_templates WHERE code IN (...);
