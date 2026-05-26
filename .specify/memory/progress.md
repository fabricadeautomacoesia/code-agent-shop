# progress.md - V1 + ERROR PAGES + SELLER REVIEWS

## STATUS: SISTEMA COMPLETO - AGUARDANDO DNS

### UX defensiva (Next.js)
- /not-found.tsx custom (404)
- /loading.tsx skeleton (suspense fallback global)
- /error.tsx (boundary com reset())

### Seller pode gerenciar reviews recebidas
- GET /api/reviews/seller/received -> reviews + product info + buyer
- /seller/dashboard/reviews UI:
  - Stats: total, avg rating, sem resposta
  - 5 estrelas visual
  - Replies inline (POST /reviews/:id/reply)
  - Badge COMPRA VERIFICADA

### Storefront (22 pages + 3 error/loading)
Auth (4) + Catalogo (4) + Sellers (2) + Compra (5) + Conta (3) + Institucional (4) + UX (3: not-found/loading/error)

### Admin (9 pages) + Seller (8 pages com /reviews novo)

### Backend (16 services Swarm UP)
- Gateway com pathRewrite + /uploads proxy
- Volume cas_uploads persistente
- Postgres 47 tabelas

### Auth completa (V8 21.6)
- JWT duplo + refresh rotation + blacklist
- 2FA TOTP + recovery codes
- Cookie cross-subdomain + auto-refresh
- Password reset E2E

### Comercio E2E
- Cart/checkout/orders/downloads
- Reviews verificadas
- Q&A bidirecional
- Reports + disputes
- Uploads de cover + package

### SEO + Legal
- robots.txt + sitemap dinamico
- /sobre + /termos + /privacidade LGPD + /cloud-code-ilimitado

### Infra
- SSL Lets Encrypt R13 auto-renew
- Backup pg_dump cron 6h
- Notification svc envia emails (cron 30s)

### PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
