# progress.md - Log de Fabrica

## Sessao: 2026-05-26

## ESTADO ATUAL: DEPLOY EM ANDAMENTO

### Codigo (100% completo)
- 47 tabelas + 14 ENUMs + 8 funcoes + 6 views
- 12 microsservicos Node + qa-worker Python
- 3 frontends Next.js 15
- ~145 arquivos de codigo
- GitHub: https://github.com/fabricadeautomacoesia/code-agent-shop (publico)

### VPS server2.inovareinteligenciaartificial.com (209.145.60.53)
| Recurso | Status |
|---|---|
| /opt/cas (repo) | OK clonado |
| DB code_agent_shop | OK 47 tabelas + seeds + admin user |
| Admin user | fabricadeautomacoes0@gmail.com / ChangeMe!2026Inovare |
| .env producao | OK gerado com secrets aleatorios |
| Postgres host | tasks.postegresp2_postgres (DNS Swarm 10.0.1.17) |
| Redis host | tasks.redis2_redis |
| Build 16 imagens | EM ANDAMENTO (background) |
| Stack Swarm deploy | PROXIMO |

### Chaves externas pendentes no .env
- ASAAS_API_KEY (e WALLET_PLATAFORMA)
- OPENAI_API_KEY / GEMINI_API_KEY / GROQ_API_KEY (pelo menos uma)
- SMTP_PASS (App Password Gmail)
- TELEGRAM_CHAT_ID

### Subdominios
- cas.inovareinteligenciaartificial.com -> storefront
- admin.cas.inovareinteligenciaartificial.com -> admin
- seller.cas.inovareinteligenciaartificial.com -> seller
- api.cas.inovareinteligenciaartificial.com -> gateway

> DNS A precisa apontar para 209.145.60.53. Traefik gera certs SSL Lets Encrypt.

## PROXIMAS MICRO-TAREFAS

| # | Tarefa |
|---|---|
| 91 | Aguardar build completar |
| 92 | docker stack deploy -c deploy/stack.inovare.yml cas |
| 93 | Verificar services cas todos rodando |
| 94 | Smoke tests via curl http://api.cas/api/status |
| 95 | Editar /opt/cas/.env com chaves Asaas/LLM/SMTP |
| 96 | DNS A records dos 4 subdominios |
| 97 | Validar SSL Lets Encrypt publico |
