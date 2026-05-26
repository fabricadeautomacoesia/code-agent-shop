# progress.md - V1 + UPLOADS + EDIT PRODUTO

## STATUS: SISTEMA COMPLETO - AGUARDANDO DNS

### Uploads E2E (NOVO)
- Multer no product-svc salva em /app/uploads (volume Swarm cas_cas_uploads)
- express.static serve /uploads/* com cache 7d
- Gateway proxia /uploads/* -> product-svc
- VALIDADO: upload + GET HTTP 200 publico
- Imagens cover + ZIP de produtos servidos publicamente

### Seller Dashboard expandido
- /products lista
- /products/[id] EDIT (NOVO): PATCH /products/me/:id + upload cover+package + Send to QA inline

### Auth completa
- Register/Login/Logout/Refresh + cookie cross-domain
- 2FA TOTP + recovery codes
- Password reset E2E (forgot + reset + revoke sessoes)
- Auto-refresh silencioso

### Comercio E2E (validado em producao)
- Cart -> Checkout PIX/Cartao/Boleto -> CAS-2026-000001
- Order paid -> Review com COMPRA VERIFICADA
- Q&A bidirecional + seller responde
- Reports + Admin moderacao

### Storefront (22 pages publicas)
Auth (4) + Catalogo (4) + Sellers (2) + Compra (5) + Conta (3) + Institucional (4)

### Admin (9 pages) + Seller (7 pages com /products/[id] novo)

### Componentes globais (10)
Nav, Footer, Providers, CartDrawer, AddToCart, ReviewForm, QnaForm, SearchAutocomplete, HeroAnimated, ProductCard

### Backend (16 services Swarm UP)
- Gateway com pathRewrite + /uploads proxy
- 12 svcs Node + qa-worker Python
- Postgres 47 tabelas + Redis
- Volume cas_uploads persistente

### Infra
- Traefik + SSL Lets Encrypt R13 auto-renew
- Backup pg_dump cron 6h + retencao 7d
- Notification svc envia emails automatico (cron 30s)

### SEO
- robots.txt + sitemap.xml dinamico
- Metadata OG pt-BR

### PENDENCIA UNICA: DNS A pelo usuario
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
