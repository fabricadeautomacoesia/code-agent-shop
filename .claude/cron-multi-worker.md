# CRON MULTI-WORKER MAXIMO - Code & Agent Shop

## Estrategia: 18 workers diferentes em paralelo

Cada cron job dispara 1 worker independente. Como o agent processa 1 task por vez,
configure MULTIPLOS crons (1 por worker) com intervalos diferentes para spread temporal.

## Configuracao recomendada: 18 crons (1 por worker)

### Frequencia base: a cada 10 minutos (stagger 30s entre crons)

```cron
# === STOREFRONT (W1-W3, W8, W9, W15) ===
*/10 * * * * /usr/bin/agent run worker-1-auth      # 00:00, 10:00, 20:00...
*/10 * * * * sleep 30 && /usr/bin/agent run worker-2-checkout
*/10 * * * * sleep 60 && /usr/bin/agent run worker-3-pdp
*/10 * * * * sleep 90 && /usr/bin/agent run worker-8-visual
*/10 * * * * sleep 120 && /usr/bin/agent run worker-9-seo
*/10 * * * * sleep 150 && /usr/bin/agent run worker-15-mobile

# === DASHBOARDS (W4, W5) ===
*/10 * * * * sleep 180 && /usr/bin/agent run worker-4-admin
*/10 * * * * sleep 210 && /usr/bin/agent run worker-5-seller

# === BACKEND SERVICES (W6, W7, W10-W13, W17) ===
*/10 * * * * sleep 240 && /usr/bin/agent run worker-6-gateway-auth
*/10 * * * * sleep 270 && /usr/bin/agent run worker-7-product-svc
*/10 * * * * sleep 300 && /usr/bin/agent run worker-10-search-aiops
*/10 * * * * sleep 330 && /usr/bin/agent run worker-11-payment-asaas
*/10 * * * * sleep 360 && /usr/bin/agent run worker-12-qa-pipeline
*/10 * * * * sleep 390 && /usr/bin/agent run worker-13-notification
*/10 * * * * sleep 420 && /usr/bin/agent run worker-17-vault-security

# === INFRA (W14, W16, W18) ===
*/10 * * * * sleep 450 && /usr/bin/agent run worker-14-db-schema
*/10 * * * * sleep 480 && /usr/bin/agent run worker-16-mlb-feature
*/10 * * * * sleep 510 && /usr/bin/agent run worker-18-performance
```

## Resultado: 18 workers/10min = ~108 micro-tarefas/hora = ~2600/dia

## Pre-requisitos VPS-side (manter idempotencia)

1. **Lock file** por worker p/ evitar overlap:
```bash
# Em cada script de worker:
LOCKFILE=/tmp/cas-worker-${WORKER_ID}.lock
[ -e $LOCKFILE ] && exit 0 || touch $LOCKFILE
trap "rm -f $LOCKFILE" EXIT
```

2. **Git pull --rebase** antes de cada execucao p/ evitar conflict
3. **Tag commit message c/ worker ID** p/ rastreio: `feat(WX pass N): ...`

## Alternativa: Crons com diferentes prioridades

```cron
# CRITICAL (a cada 5min): bugs em prod, security, payment
*/5 * * * * /usr/bin/agent run worker-11-payment-asaas
*/5 * * * * sleep 60 && /usr/bin/agent run worker-17-vault-security
*/5 * * * * sleep 120 && /usr/bin/agent run worker-2-checkout

# HIGH (a cada 15min): user-facing, SEO, dashboards
*/15 * * * * /usr/bin/agent run worker-3-pdp
*/15 * * * * sleep 60 && /usr/bin/agent run worker-4-admin
*/15 * * * * sleep 120 && /usr/bin/agent run worker-9-seo

# MEDIUM (a cada 30min): infrastructure, performance
*/30 * * * * /usr/bin/agent run worker-14-db-schema
*/30 * * * * sleep 60 && /usr/bin/agent run worker-18-performance

# LOW (a cada 1h): MLB features, melhorias UX
0 * * * * /usr/bin/agent run worker-16-mlb-feature
0 * * * * sleep 60 && /usr/bin/agent run worker-8-visual
```

## Estado atual passes acumuladas

- 128 passes documentadas em progress.md
- Cron rate atual aprox: ~3 passes/hora
- Com config 18 workers paralelos: ~108 passes/hora (36x)

## Risk mitigation

1. **GitHub rate limit**: 5000 reqs/hour por token - 108 passes/hora OK
2. **Git push conflicts**: stagger 30s evita 99% dos overlaps
3. **Build queue**: docker swarm rebuild atomico ja garante isolation
4. **Lock files** evitam mesmo worker rodando 2x simultaneo
