# progress.md - V1 PRODUCAO REAL

## STATUS: SISTEMA COMERCIAL COMPLETO - AGUARDANDO DNS

### Fluxos validados E2E em producao

**Fluxo de compra completo:**
1. Buyer cadastrado: teste1@cas.io
2. Login + JWT + cookie cas_rt cross-domain
3. Add ao cart (prompt-pack R$ 19)
4. Checkout PIX -> CAS-2026-000001 criado
5. Pagamento confirmado (manual via SQL para teste)
6. Review postada com COMPRA VERIFICADA badge
7. Review visivel no PDP publico

**Fluxo Q&A bidirecional:**
1. Buyer pergunta sobre produto: a8521fd1
2. Pergunta aparece no PDP publico
3. Seller responde via /seller/qna dashboard
4. Buyer recebe notification in_app

**Fluxo Reports:**
1. Buyer denuncia produto: 63372209
2. Admin ve em /admin/reports
3. Admin resolve com notes

### Capacidades comerciais (validadas)
- Cart persistente + cupons + CartDrawer lateral
- Checkout PIX/Cartao/Boleto via Asaas Split
- Orders com snapshot + license_key + download_token
- Reviews verificadas (must order paid)
- Q&A bidirecional com notification
- Reports + Disputes + Mediation

### Capacidades operacionais
- Admin: 9 paginas (todas com endpoints reais)
- Seller: 6 paginas (com cronometro SLA Classe B)
- SEO: robots + sitemap dinamico
- Status page publica (V8 5.3)
- Backup pg_dump cron 6h

### Auth completa (V8 21.6)
- JWT duplo 15min+7d
- Refresh rotation + blacklist
- Cookie Domain=.cas. cross-subdomain
- Auto-refresh silencioso em 401
- 2FA TOTP com recovery codes
- Fail2Ban in-memory

### Infra
- 16 services Swarm UP
- Traefik + SSL Lets Encrypt R13
- Postgres 14 reusado + Redis 7
- Backup automatizado

### Storefront (16 pages publicas) + 9 components globais
### Admin (9 pages) + Seller (6 pages)

### PENDENCIA UNICA
DNS A pelo usuario:
- cas.inovareinteligenciaartificial.com -> 209.145.60.53
- api.cas.inovareinteligenciaartificial.com -> 209.145.60.53
- admin.cas.inovareinteligenciaartificial.com -> 209.145.60.53
- seller.cas.inovareinteligenciaartificial.com -> 209.145.60.53
