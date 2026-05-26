# progress.md - V1 OPERACIONAL COMPLETA

## STATUS: PRONTA PARA TRAFEGO REAL - AGUARDANDO APENAS DNS

### Auth cross-subdomain
- Cookie cas_rt com Domain=.cas.inovareinteligenciaartificial.com
- Refresh rotation + blacklist (V8 21.6)

### Fluxos E2E validados em producao
| Fluxo | Status |
|---|---|
| Register buyer/seller | OK |
| Login + JWT 15min | OK |
| Refresh com rotacao | OK |
| Add to cart + checkout PIX | OK (CAS-2026-000001) |
| List orders + detail page | OK |
| POST Q&A no PDP | OK (a8521fd1) |
| Q&A aparece publico no PDP | OK |
| Report criado pelo buyer | OK (63372209) |
| Admin lista reports | OK |
| Admin lista orders + stats | OK |

### Backup automatizado
- /opt/cas/deploy/cron-backup.sh
- cron */6h
- retencao 7 dias
- testado: 47KB gzipped por dump

### Frontends (storefront 13 / admin 9 / seller 6)
- PDP com QnaForm integrado
- /conta/pedidos lista completa + /conta/pedidos/[id] detalhe
- /conta/downloads/[token] download seguro
- /conta/seguranca 2FA TOTP

### SSL
- Lets Encrypt R13 auto-renew

### PENDENCIA UNICA: DNS A records
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
