# projeto_code_agent_shop.md — Diário Oficial do Projeto

## OBJETIVO

Marketplace B2B/B2C **multi-seller** dedicado à compra, venda e licenciamento de:
- Automações
- Scripts
- Workflows n8n
- Agentes de Inteligência Artificial
- Templates de código

Inspiração UX: **Mercado Livre** (reputação, Q&A, mediação de disputas, proteção ao comprador, categorização elástica).

---

## STACKS (decididas conforme Blueprint V8)

| Camada | Tecnologia |
|---|---|
| Gateway | Node.js + http-proxy-middleware |
| Backend principal | Node.js + Express 5 |
| Banco | PostgreSQL 16 (sem ORM, `pg` nativo) |
| Cache/Sessions | Redis (com fallback in-memory via Map) |
| Queue | BullMQ (com fallback síncrono) |
| QA Worker | Python 3.12 + LangChain + LLM fallback OpenAI→Gemini→Groq |
| Frontend | Next.js 16 SSR + Tailwind 4 + GSAP + Lenis |
| Auth | JWT duplo (access 15min + refresh 7d HTTP-only) + 2FA TOTP |
| Pagamento | Asaas (split nativo) |
| Mail | nodemailer |
| WhatsApp | Evolution API |
| Deploy | Docker Swarm + Traefik + Portainer |
| Observability | server_aiops.js (CPU/RAM/Disco + Telegram/SMTP/Webhook) |

---

## MICROSSERVIÇOS (15 ao todo)

| # | Serviço | Porta | Stack |
|---|---|---|---|
| 01 | gateway          | 3002 | Node |
| 02 | auth-svc         | 3010 | Node |
| 03 | seller-svc       | 3011 | Node |
| 04 | product-svc      | 3012 | Node |
| 05 | qa-svc           | 3013 | Node |
| 06 | qa-worker        | 3014 | Python |
| 07 | order-svc        | 3015 | Node |
| 08 | payment-svc      | 3016 | Node |
| 09 | review-svc       | 3017 | Node |
| 10 | notification-svc | 3018 | Node |
| 11 | search-svc       | 3019 | Node |
| 12 | vault-svc        | 3020 | Node |
| 13 | aiops-svc        | 3006 | Node |
| 14 | storefront       | 3000 | Next.js 16 |
| 15 | dashboard-admin  | 3001 | Next.js 16 |
| 16 | dashboard-seller | 3003 | Next.js 16 |

---

## REGRAS DE NEGÓCIO IMUTÁVEIS

1. **Take Rate:** 18% (plataforma) / 82% (seller).
2. **Cláusula Master de Revenda Direta:** plataforma pode vender qualquer ativo diretamente (100% lucro, sem comissão ao criador).
3. **Classe A:** independentes, próprias API keys.
4. **Classe B:** patrocinados Cloud Code Ilimitado, keys injetadas pelo cofre, SLA upload obrigatório a cada 15 dias (default), pena: revogação automática.
5. **QA Automatizado:** todo upload passa por webhook n8n + LLM scoring; <80% confidence = REJECTED automático.
6. **Pagamento:** apenas Asaas, com Split nativo.
7. **Métodos:** PIX, Cartão, Boleto.

---

## HISTÓRICO

| Data | Evento |
|---|---|
| 2026-05-26 | Boot do Code Shop, ingestão Blueprint V8, criação `.specify/memory/`, decisão tri-stack + 15 microsserviços |
| 2026-05-26 | Configuração de hard-limit 20k chars/resposta (anti-524) + modo autônomo contínuo |
| 2026-05-26 | Bootstrap raiz: este arquivo |

---

## POLÍTICA DE BACKUPS

- Todo arquivo crítico do projeto possui versão `.bak` antes de edição destrutiva.
- Banco: `pg_dump` via node-cron a cada 6h, retenção 7 dias.
- Repositório: versionamento via GitHub (a configurar).

---

## PENDÊNCIAS EXTERNAS

- [ ] Credenciais VPS (IP, SSH key, domínio)
- [ ] Token GitHub para push automático
- [ ] Chave Asaas (sandbox + produção)
- [ ] Pelo menos 1 LLM key (OpenAI ou Gemini ou Groq)
- [ ] URL n8n self-hosted + webhook secret
- [ ] Evolution API URL+token (fase 6 — notificações WhatsApp)
