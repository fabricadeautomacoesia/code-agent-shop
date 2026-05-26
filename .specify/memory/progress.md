# progress.md - V1 PUBLICA + AUTH ROTATION FUNCIONANDO

## STATUS: PRODUCAO PUBLICA E2E - AGUARDANDO APENAS DNS

### Auth flow completo validado (HTTPS publico)
1. POST /api/auth/register {role} -> user criado
2. POST /api/auth/login -> JWT access + cookie cas_rt path=/
3. POST /api/auth/refresh -> new JWT + cookie rotacionado, antigo na blacklist
4. POST /api/auth/logout -> session revogada, cookie clear path=/
5. GET /api/auth/me com Bearer -> user payload

### Fluxo Buyer (executado em producao)
- Register teste1@cas.io -> user e240c6c4
- Login -> JWT 337 chars
- /cart/items {prompt-pack} -> ok
- /orders/checkout {pix} -> CAS-2026-000001 (R$ 19, pending_payment)
- /orders -> lista

### Fluxo Seller (executado em producao)
- Register vendedor1@cas.io -> user dc088c4a + seller class_a pending_kyc
- /sellers/me -> seller_profile completo
- /products/me -> [] (correto)

### Endpoints publicos validados
- /api/products, /api/products/[slug], /api/search, /api/search/categories
- /api/search/trending, /api/aiops/status, /api/aiops/metrics/latest

### Storefront pages criadas/atualizadas
- /conta/pedidos/[id] (PIX QR + license keys + download buttons)
- /conta/downloads/[token] (download seguro + license display)
- /conta/seguranca (2FA TOTP completo)
- Home / com fetchSafe + force-dynamic (10 produtos demo aparecem)

### Bugs resolvidos hoje
1. ltree, NOW() index, DNS Swarm, Next public, Suspense
2. Dockerfile monorepo + HEALTHCHECK
3. Express 5 sanitize, gateway upstreams, pathRewrite funcao
4. auth-svc u2.secret_iv
5. Routes order: /me, /admin, /download captured by :slug (3 svcs)
6. Cookie path=/auth -> path=/ para refresh via gateway

### SSL
- Lets Encrypt R13
- 2026-05-26 -> 2026-08-24 (auto-renew Traefik)

### Login admin
- fabricadeautomacoes0@gmail.com / ChangeMe!2026Inovare

### PENDENCIA UNICA: DNS A records (usuario)
- cas.inovareinteligenciaartificial.com -> 209.145.60.53
- api.cas.inovareinteligenciaartificial.com -> 209.145.60.53
- admin.cas.inovareinteligenciaartificial.com -> 209.145.60.53
- seller.cas.inovareinteligenciaartificial.com -> 209.145.60.53
