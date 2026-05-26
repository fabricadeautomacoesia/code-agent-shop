# progress.md - V1 COMERCIAL + SEO + ADMIN COMPLETO

## STATUS: SISTEMA OPERACIONAL COM SEO - AGUARDANDO DNS

### Funcionalidades validadas em producao
- Auth: register/login/refresh com rotation + 2FA TOTP + auto-refresh silencioso
- Cart: Add/Remove/Coupon + CartDrawer lateral global
- Checkout: PIX QR + Boleto + Cartao + pedido CAS-2026-000001
- Q&A: POST publica + listagem no PDP
- Admin: orders/recent com stats live, reports/list+resolve, qa-queue, payouts, vault, alerts
- Seller: cronometro SLA + KYC + payouts
- Status page publica: CPU/RAM/Disk + services + alerts

### SEO (Google-ready)
- /robots.txt com allow/disallow + Sitemap + Host
- /sitemap.xml dinamico: 6 estaticas + 10 produtos + N sellers
- Open Graph metadata pt-BR no layout
- Auto-revalidate de sitemap

### Storefront (16 paginas publicas)
- Componentes globais: Nav, Footer, Providers (Lenis+GSAP), ProductCard, QnaForm, HeroAnimated, SearchAutocomplete, CartDrawer, AddToCart

### Admin (9 paginas) - todas com endpoints reais
- /, /sellers, /qa-queue, /products, /orders (com /admin/recent + stats), /payouts, /reports, /alerts, /vault

### Seller (6 paginas)
- /, /products, /upload, /qna, /financeiro, /loja

### Backend (16 services Swarm UP)
- Gateway pathRewrite por svc
- 12 svcs Node + qa-worker Python + 3 fronts
- DB Postgres 47 tabelas + 10 produtos + admin + sellers + Q&A + reports

### Infra
- Docker Swarm + Traefik + SSL Lets Encrypt R13 auto-renew
- Backup pg_dump cron 6h + retencao 7d
- Cookie cross-subdomain .cas. (auth compartilhado entre cas e api.cas)

### PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
