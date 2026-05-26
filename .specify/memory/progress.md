# progress.md - V1 PRODUCAO COMERCIAL COMPLETA

## STATUS: SISTEMA OPERACIONAL EM PRODUCAO - AGUARDANDO DNS

### Auth completa (V8 §4)
- Register/Login/Logout/Refresh com rotation + blacklist
- 2FA TOTP (QR + recovery codes)
- Auto-refresh silencioso em 401
- Cookie cross-subdomain .cas.
- **Password reset E2E:**
  - /esqueci-senha -> /api/auth/forgot-password -> notification (email)
  - /redefinir-senha?token=X -> /api/auth/reset-password -> revoga sessoes
  - Token TTL 15min + bcrypt rehash + body_html template

### Fluxo comercial validado em producao
1. Buyer cadastrado teste1@cas.io
2. Cart -> Checkout PIX -> CAS-2026-000001
3. Order marcada paid (via SQL manual para teste)
4. POST /api/reviews com is_verified_purchase=true
5. Review aparece no PDP com badge COMPRA VERIFICADA

### Fluxo Q&A bidirecional
1. Buyer POST /api/qna -> pergunta a8521fd1
2. Aparece publico no PDP
3. Seller responde via /seller/qna dashboard
4. Buyer notificado in_app

### Frontends storefront (18 pages publicas)
- Auth: /login, /register, /esqueci-senha, /redefinir-senha
- Catalogo: /, /products, /product/[slug] (com QnaForm + AddToCart + ReviewForm trigger)
- Sellers: /sellers, /seller/[slug]
- Compra: /cart, /checkout
- Conta: /conta, /conta/pedidos, /conta/pedidos/[id] (com ReviewForm), /conta/downloads/[token], /conta/seguranca
- Operacional: /status

### Admin (9 pages) + Seller (6 pages) com endpoints reais

### Componentes globais (10)
Nav, Footer, Providers, CartDrawer, AddToCart, ReviewForm, QnaForm, SearchAutocomplete, HeroAnimated, ProductCard

### Backend (16 services Swarm UP)
- Gateway com pathRewrite por svc
- Postgres 47 tabelas + Redis
- Backup pg_dump cron 6h

### SEO + Infra
- robots.txt + sitemap.xml dinamico
- SSL Lets Encrypt R13 auto-renew
- Notification svc envia emails automatico (cron 30s)

### PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
