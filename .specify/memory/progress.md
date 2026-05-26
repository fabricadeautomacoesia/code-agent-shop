# progress.md - Log de Fabrica

## Sessao: 2026-05-26

## STATUS: V1 EM PRODUCAO - 16/16 SERVICES UP + ENDPOINTS VALIDADOS

### Codigo
- 47 tabelas + 14 ENUMs + 8 funcoes + 6 views (PostgreSQL 14)
- 12 microsservicos Node + qa-worker Python
- 3 frontends Next.js 15
- ~155 arquivos
- GitHub: https://github.com/fabricadeautomacoesia/code-agent-shop (publico)

### VPS server2.inovareinteligenciaartificial.com (209.145.60.53)
- Debian 12 + Docker 28.5 + Swarm
- Traefik v2.11 + letsencryptresolver
- Postgres 14 reusado (postegresp2)
- Redis 7 reusado (redis2)
- Network minha_rede
- Stack cas: 16/16 services UP

### Bugs resolvidos no deploy (commits)
1. ltree removido
2. NOW() em index predicate removido
3. DNS Swarm tasks.postegresp2_postgres
4. Next public/ mkdir runtime
5. useSearchParams em Suspense
6. Dockerfile.node copia monorepo + include-workspace-root
7. HEALTHCHECK removido
8. Express 5 sanitize in-place
9. Gateway upstreams via Swarm DNS
10. Gateway pathRewrite via funcao
11. auth-svc u2.iv -> u2.secret_iv

### Endpoints validados E2E
- POST /api/auth/login -> JWT 15min OK
- GET /api/products -> []
- GET /api/search/categories -> 7+18 cats
- GET /api/search?q=X -> results
- GET /api/aiops/status -> metrics OK

## ACAO USUARIO NECESSARIA

1. DNS A 4 subdominios -> 209.145.60.53
2. Chaves Asaas/LLM/SMTP em /opt/cas/.env
