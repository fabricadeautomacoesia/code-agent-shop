# progress.md - V1 PUBLICA + UI PREMIUM + SELLER PAGES

## STATUS: PRODUCAO READY - AGUARDANDO DNS

### Frontends Storefront (14 pages publicas validadas)
1. / com HeroAnimated 3D + Mais vendidos + Trending
2. /products (lista filtravel)
3. /product/[slug] PDP com QnaForm integrado
4. /seller/[slug] (loja publica do vendedor com banner+tier+stats+produtos)
5. /login, /register
6. /cart, /checkout (PIX QR + Boleto + Cartao)
7. /conta, /conta/pedidos, /conta/pedidos/[id], /conta/downloads/[token]
8. /conta/seguranca 2FA TOTP

### Componentes globais
- Nav scroll-aware com SearchAutocomplete modal (debounce 200ms + trending)
- QnaForm (POST /api/qna com auto-login redirect)
- ProductCard com tier badges
- HeroAnimated 3D (4 cards + parallax mouse + glow orb)

### Auth (V8 21.6)
- JWT 15min + refresh 7d (cookie HttpOnly Secure SameSite=Lax)
- Domain=.cas.inovareinteligenciaartificial.com (cross-subdomain)
- Refresh rotation com blacklist do antigo
- Auto-refresh silencioso em 401 + retry

### Backend (16 services Swarm)
- 12 svcs Node + qa-worker Python + 3 fronts
- Gateway com pathRewrite por svc
- DB Postgres 47 tabelas + 10 produtos + Q&A + reports + 1 order

### Backup automatizado
- /opt/cas/deploy/cron-backup.sh
- Cron 0 */6 * * *
- Retencao 7d
- pg_dump 47KB gzipped por dump

### SSL Lets Encrypt R13 auto-renew

### PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
