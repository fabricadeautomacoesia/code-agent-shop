# Code & Agent Shop

> Marketplace B2B/B2C multi-seller dedicado a automacoes, scripts, workflows n8n e agentes de IA.
> Construido sob o Blueprint V8 da Inovare AI Ecosystem.

---

## Arquitetura

- **Tri-stack:** Node.js (concorrencia/APIs) + Python (RAG/QA) + Next.js 16 (frontends).
- **Banco:** PostgreSQL 16 com auto-migracao tolerante e self-healing de deadlocks.
- **Cache/Queue:** Redis + BullMQ com fallback in-memory.
- **Deploy:** Docker Swarm + Traefik + Portainer.
- **Pagamentos:** Asaas com Split nativo.
- **QA Automatizado:** webhook n8n + LLM scoring (OpenAI -> Gemini -> Groq fallback).

## Microsservicos

| Servico | Porta | Stack | Responsabilidade |
|---|---|---|---|
| gateway          | 3002 | Node | Proxy + rate-limit + IP block |
| auth-svc         | 3010 | Node | JWT duplo + 2FA TOTP + Fail2Ban |
| seller-svc       | 3011 | Node | CRUD sellers + Classes A/B + SLA cron |
| product-svc      | 3012 | Node | CRUD produtos + versionamento |
| qa-svc           | 3013 | Node | Orquestrador webhook QA |
| qa-worker        | 3014 | Python | Analise estatica + LLM scoring |
| order-svc        | 3015 | Node | Carrinho + checkout + mediacao |
| payment-svc      | 3016 | Node | Asaas + Split + webhooks |
| review-svc       | 3017 | Node | Reviews + Q&A + reputacao |
| notification-svc | 3018 | Node | Email + Push + WhatsApp |
| search-svc       | 3019 | Node | Full-text Postgres + ranking custom |
| vault-svc        | 3020 | Node | Cofre AES-256 de API keys |
| aiops-svc        | 3006 | Node | Metricas + auto-heal + alertas |
| storefront       | 3000 | Next.js 16 | Vitrine publica SSR |
| dashboard-admin  | 3001 | Next.js 16 | Painel master |
| dashboard-seller | 3003 | Next.js 16 | Painel vendedor |

## Regras de Negocio

- **Take Rate:** 18% plataforma / 82% seller (split Asaas nativo).
- **Clausula Master de Revenda Direta:** plataforma pode revender qualquer ativo (100% lucro).
- **Classe A:** independentes (proprias keys de API).
- **Classe B:** patrocinados (keys injetadas pelo vault), SLA upload obrigatorio a cada 15d.
- **QA Gate:** confidence score >= 80% para aprovacao; rejeicao nao zera timer SLA.

## Setup Local

```bash
# 1. Postgres + Redis (Docker)
docker run -d --name cas-postgres -p 5432:5432 -e POSTGRES_PASSWORD=changeme_strong_password_2026 -e POSTGRES_USER=codeshop -e POSTGRES_DB=code_agent_shop postgres:16
docker run -d --name cas-redis -p 6379:6379 redis:7-alpine

# 2. Variaveis de ambiente
cp .env.example .env
# editar .env com chaves reais

# 3. Migrations
npm run db:migrate

# 4. Subir microsservicos em paralelo
npm run dev
```

## Estrutura do Repositorio

```
code-agent-shop/
├── db/
│   ├── migrations/         # SQL versionado (001_init.sql, 002_*.sql, ...)
│   └── seeds/              # Dados de teste
├── packages/
│   ├── shared/             # Utils compartilhados (logger, sanitize, withRetry, jwt)
│   └── db-client/          # Wrapper pg + fail-safe
├── services/
│   ├── gateway/
│   ├── auth-svc/
│   ├── seller-svc/
│   ├── product-svc/
│   ├── qa-svc/
│   ├── qa-worker/          # Python
│   ├── order-svc/
│   ├── payment-svc/
│   ├── review-svc/
│   ├── notification-svc/
│   ├── search-svc/
│   ├── vault-svc/
│   └── aiops-svc/
├── apps/
│   ├── storefront/         # Next.js 16
│   ├── dashboard-admin/    # Next.js 16
│   └── dashboard-seller/   # Next.js 16
├── docs/
│   ├── ARQUITETURA.md
│   ├── API.md
│   └── adr/                # Architecture Decision Records
├── deploy/
│   ├── docker-compose.yml  # Dev local
│   ├── stack.yml           # Swarm producao
│   └── ecosystem.config.js # PM2 (alternativa Docker)
├── .env.example
├── .gitignore
├── projeto_code_agent_shop.md
├── package.json
└── README.md
```

## Licenca

Privada — Inovare AI Ecosystem.
