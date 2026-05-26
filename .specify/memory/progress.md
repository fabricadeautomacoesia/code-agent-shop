# progress.md - V1 + NOTIFICATION BELL E2E

## STATUS: SISTEMA COMPLETO COMERCIAL + UX - AGUARDANDO DNS

### Componentes globais (11 - + NotificationBell)
- Nav (sticky scroll-aware, search modal, **bell com badge unread + polling 60s**)
- Footer
- Providers (Lenis+GSAP)
- CartDrawer (lateral global)
- AddToCart (PDP)
- ReviewForm (post-purchase)
- QnaForm (PDP)
- SearchAutocomplete (modal + trending)
- HeroAnimated (3D parallax)
- ProductCard (tier badges)
- **NotificationBell** (dropdown + mark-as-read)

### Auth completa (V8 21.6)
- Register/Login/Logout/Refresh + cookie cross-domain .cas.
- 2FA TOTP + recovery codes
- Password reset E2E
- Auto-refresh silencioso

### Fluxos E2E validados em producao
- Compra: cart -> checkout PIX -> CAS-2026-000001 -> review COMPRA VERIFICADA
- Q&A bidirecional
- Notification a4361222 -> bell renderiza + mark-as-read funciona

### Storefront (25 pages: 22 + 3 UX defensiva)
- Auth (4): login/register/esqueci-senha/redefinir-senha
- Catalogo (4): /, /products, /product/[slug], /status
- Sellers (2): /sellers, /seller/[slug]
- Compra (5): /cart, /checkout, /conta/pedidos, /conta/pedidos/[id], /conta/downloads/[token]
- Conta (3): /conta, /conta/seguranca, /conta/pedidos
- Institucional (4): /sobre, /termos, /privacidade, /cloud-code-ilimitado
- UX (3): not-found/loading/error

### Admin (9) + Seller (8)

### Backend (16 services Swarm UP)
- Gateway + /uploads proxy
- Volume cas_uploads persistente
- Postgres 47 tabelas + Redis
- Backup pg_dump 6h

### SEO + Legal
- robots.txt + sitemap dinamico
- LGPD compliant

### Infra
- SSL Lets Encrypt R13 auto-renew
- Notification svc cron 30s (emails)

### PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
