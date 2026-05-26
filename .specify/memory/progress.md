# progress.md - Log de Fabrica

## Sessao: 2026-05-26

## RESUMO DO PROJETO (V1 CONCLUIDA)

| Camada | Status |
|---|---|
| DB Schema (47 tabelas, 14 ENUMs, 8 funcoes, 6 views) | OK |
| Bin runners (migrate, seed, backup, reset, refresh-kpi, dev-all, smoke-tests, vps-ssh, vps-deploy) | OK |
| packages/shared (13 modulos) + packages/db-client | OK |
| 12 microsservicos Node + 1 Python (qa-worker FastAPI) | OK |
| 3 frontends Next.js 15 (storefront 9p, admin 6p, seller 5p) | OK |
| Deploy infra (docker-compose, Dockerfiles, stack.yml, PM2, README) | OK |
| Git: commit bbe54d4 + push GitHub fabricadeautomacoesia/code-agent-shop | OK |

## VPS DESCOBERTA (server2.inovareinteligenciaartificial.com / 209.145.60.53)

- Debian 12 + Docker 28.5.1 + Swarm ativo (1 manager, 2 nodes)
- Traefik v2.11.2 com certresolver letsencryptresolver (Lets Encrypt via emersonjosielmrx@gmail.com)
- Postgres 14.22 (postegresp2): user=postgres, pass=58cf114a50f1b151e2c389c835c1b2d0
- Redis 7 (redis2)
- MinIO, n8n (3 svcs), RabbitMQ, Portainer disponiveis
- Network swarm: `minha_rede` (overlay attachable) - NAO eh `network_swarm_public` como padrao V8
- Entrypoints Traefik: web (80) + websecure (443) com redirect HTTPS auto
- Disco: 394G total / 62G usado / 317G livre (17%)
- Memoria: 23GB total / 4GB usado / 19GB livre

## PROXIMAS MICRO-TAREFAS (DEPLOY VPS)

| # | Tarefa | Status |
|---|---|---|
| 82 | Criar DB `code_agent_shop` no Postgres existente (postegresp2) | PROXIMA |
| 83 | Ajustar stack.yml: network=minha_rede + remover Postgres+Redis internos + apontar para postegresp2/redis2 | |
| 84 | Subdominios decididos: cas.inovareinteligenciaartificial.com (store) + admin.* + seller.* + api.* | |
| 85 | git clone https://github.com/fabricadeautomacoesia/code-agent-shop /opt/cas | |
| 86 | Criar .env producao na VPS (chaves Asaas/LLM/SMTP/Telegram/JWT pendentes) | |
| 87 | docker compose build (na VPS) dos 12 svcs + qa-worker + 3 fronts | |
| 88 | Rodar migrations: docker exec gateway node bin/migrate.js && bin/seed.js | |
| 89 | docker stack deploy -c stack.yml cas | |
| 90 | Smoke tests via api.cas.inovareinteligenciaartificial.com | |
| 91 | Apontar DNS dos 4 subdominios para 209.145.60.53 | |
