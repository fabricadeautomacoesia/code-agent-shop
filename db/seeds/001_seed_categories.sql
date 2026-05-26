-- ============================================================
-- 001_seed_categories.sql
-- Categorias base do marketplace (Mega Menu)
-- ============================================================

INSERT INTO categories (id, parent_id, slug, name, name_singular, description, icon, depth, sort_order, is_featured) VALUES
    ('11111111-0001-0000-0000-000000000001', NULL, 'automacoes', 'Automacoes', 'Automacao', 'Scripts e fluxos de automacao prontos para uso', 'workflow', 0, 10, TRUE),
    ('11111111-0002-0000-0000-000000000001', NULL, 'agentes-ia', 'Agentes de IA', 'Agente de IA', 'Agentes autonomos com LLM (RAG, chatbots, assistentes)', 'bot', 0, 20, TRUE),
    ('11111111-0003-0000-0000-000000000001', NULL, 'workflows-n8n', 'Workflows n8n', 'Workflow n8n', 'Templates prontos para importar no n8n', 'git-fork', 0, 30, TRUE),
    ('11111111-0004-0000-0000-000000000001', NULL, 'scripts', 'Scripts', 'Script', 'Scripts Node, Python, PHP, Shell', 'code-2', 0, 40, TRUE),
    ('11111111-0005-0000-0000-000000000001', NULL, 'templates', 'Templates', 'Template', 'Templates de codigo, prompts e dashboards', 'layout-template', 0, 50, FALSE),
    ('11111111-0006-0000-0000-000000000001', NULL, 'datasets', 'Datasets', 'Dataset', 'Datasets curados para treino e fine-tuning', 'database', 0, 60, FALSE),
    ('11111111-0007-0000-0000-000000000001', NULL, 'prompt-packs', 'Prompt Packs', 'Prompt Pack', 'Coletaneas de prompts otimizados', 'message-square-text', 0, 70, TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Subcategorias de Automacoes
INSERT INTO categories (parent_id, slug, name, depth, sort_order) VALUES
    ('11111111-0001-0000-0000-000000000001', 'automacao-whatsapp', 'WhatsApp', 1, 10),
    ('11111111-0001-0000-0000-000000000001', 'automacao-email', 'Email Marketing', 1, 20),
    ('11111111-0001-0000-0000-000000000001', 'automacao-crm', 'CRM', 1, 30),
    ('11111111-0001-0000-0000-000000000001', 'automacao-ecommerce', 'E-commerce', 1, 40),
    ('11111111-0001-0000-0000-000000000001', 'automacao-financeira', 'Financeira', 1, 50),
    ('11111111-0001-0000-0000-000000000001', 'automacao-scraping', 'Web Scraping', 1, 60)
ON CONFLICT (slug) DO NOTHING;

-- Subcategorias de Agentes IA
INSERT INTO categories (parent_id, slug, name, depth, sort_order) VALUES
    ('11111111-0002-0000-0000-000000000001', 'agente-rag', 'RAG / Knowledge Base', 1, 10),
    ('11111111-0002-0000-0000-000000000001', 'agente-atendimento', 'Atendimento ao Cliente', 1, 20),
    ('11111111-0002-0000-0000-000000000001', 'agente-vendas', 'Vendas / SDR', 1, 30),
    ('11111111-0002-0000-0000-000000000001', 'agente-codigo', 'Coding Assistant', 1, 40),
    ('11111111-0002-0000-0000-000000000001', 'agente-pesquisa', 'Research / Web', 1, 50),
    ('11111111-0002-0000-0000-000000000001', 'agente-multi', 'Multi-Agent (CrewAI/LangGraph)', 1, 60)
ON CONFLICT (slug) DO NOTHING;

-- Subcategorias de Scripts
INSERT INTO categories (parent_id, slug, name, depth, sort_order) VALUES
    ('11111111-0004-0000-0000-000000000001', 'script-node', 'Node.js', 1, 10),
    ('11111111-0004-0000-0000-000000000001', 'script-python', 'Python', 1, 20),
    ('11111111-0004-0000-0000-000000000001', 'script-php', 'PHP', 1, 30),
    ('11111111-0004-0000-0000-000000000001', 'script-bash', 'Bash / Shell', 1, 40),
    ('11111111-0004-0000-0000-000000000001', 'script-go', 'Go', 1, 50),
    ('11111111-0004-0000-0000-000000000001', 'script-rust', 'Rust', 1, 60)
ON CONFLICT (slug) DO NOTHING;

-- Tags oficiais iniciais
INSERT INTO tags (slug, name, color_hex, is_official) VALUES
    ('openai',           'OpenAI',           '#10A37F', TRUE),
    ('anthropic',        'Anthropic',        '#D97757', TRUE),
    ('gemini',           'Gemini',           '#4285F4', TRUE),
    ('langchain',        'LangChain',        '#1C3D5A', TRUE),
    ('rag',              'RAG',              '#7C3AED', TRUE),
    ('whatsapp',         'WhatsApp',         '#25D366', TRUE),
    ('evolution-api',    'Evolution API',    '#34B7F1', TRUE),
    ('postgres',         'PostgreSQL',       '#336791', TRUE),
    ('redis',            'Redis',            '#DC382D', TRUE),
    ('docker',           'Docker',           '#2496ED', TRUE),
    ('typescript',       'TypeScript',       '#3178C6', TRUE),
    ('plug-and-play',    'Plug & Play',      '#22C55E', TRUE),
    ('production-ready', 'Production Ready', '#F59E0B', TRUE)
ON CONFLICT (slug) DO NOTHING;

-- Templates de notificacao base
INSERT INTO notification_templates (code, name, channel, subject_template, body_template) VALUES
    ('product_submitted',     'Produto enviado',             'email', 'Recebemos seu produto {{title}}',       'Ola {{name}},\n\nSeu produto "{{title}}" entrou na fila de revisao automatizada (QA). Voce sera notificado em alguns minutos.'),
    ('product_approved',      'Produto aprovado',            'email', 'Produto aprovado: {{title}}',           'Parabens, {{name}}! Seu produto "{{title}}" foi aprovado (confidence {{score}}). Ja esta na vitrine!'),
    ('product_rejected',      'Produto rejeitado',           'email', 'Necessario ajustar: {{title}}',         'Ola {{name}},\n\nSeu produto "{{title}}" nao passou no QA automatizado.\nMotivos:\n{{reasons}}\n\nFaca os ajustes e reenvie. O timer SLA continua correndo.'),
    ('sla_warning_7d',        'SLA: 7 dias restantes',       'email', '7 dias para seu proximo upload',        'Atencao {{name}},\n\nVoce tem 7 dias para enviar um novo produto aprovado. Caso contrario, suas API keys serao revogadas automaticamente.'),
    ('sla_warning_3d',        'SLA: 3 dias restantes',       'email', 'URGENTE: 3 dias para upload',           'Atencao {{name}},\n\nApenas 3 dias restantes!'),
    ('sla_warning_1d',        'SLA: 1 dia restante',         'email', 'ULTIMO DIA: upload em 24h',             'Atencao {{name}},\n\nVoce tem ate amanha para enviar um produto aprovado.'),
    ('sla_revoked',           'API keys revogadas',          'email', 'Acesso suspenso',                       'Ola {{name}},\n\nSeu SLA expirou. As API keys da plataforma foram revogadas. Entre em contato com suporte para reativar.'),
    ('order_paid',            'Pagamento confirmado',        'email', 'Pagamento confirmado #{{order_number}}', 'Ola {{name}},\n\nSeu pagamento foi confirmado. Acesse seus produtos em {{download_url}}'),
    ('seller_new_sale',       'Nova venda',                  'email', 'Nova venda: {{product_title}}',         'Parabens {{name}}! Voce vendeu "{{product_title}}". Valor liquido: R$ {{payout}}'),
    ('dispute_opened',        'Disputa aberta',              'email', 'Disputa aberta no pedido #{{order_number}}', 'Uma disputa foi aberta. Acesse {{dispute_url}} para responder em ate 48h.'),
    ('review_received',       'Nova avaliacao',              'in_app', NULL,                                   'Voce recebeu uma avaliacao de {{rating}} estrelas em "{{product_title}}"'),
    ('qna_question',          'Nova pergunta',               'in_app', NULL,                                   '{{user}} fez uma pergunta em "{{product_title}}". Responda em ate 24h para manter sua reputacao.')
ON CONFLICT (code) DO NOTHING;
