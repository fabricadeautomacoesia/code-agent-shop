# progress.md - V1 PRODUCAO + LEGAL COMPLIANCE

## STATUS: SISTEMA COMERCIAL + LEGAL OPERACIONAL - AGUARDANDO DNS

### Conformidade legal e institucional (NOVO)
- **/sobre** - apresentacao da plataforma + missao + para compradores/vendedores
- **/termos** - Termos de Uso com Clausula Master de Revenda Direta destacada
- **/privacidade** - Politica LGPD (Art. 7, 18) - dados, bases legais, retencao, cookies
- **/cloud-code-ilimitado** - landing do programa Classe B (API keys patrocinadas + SLA 15d)

### Auth completa
- Register/Login/Logout/Refresh + cookie cross-domain + auto-refresh
- 2FA TOTP com QR + recovery codes
- **Password reset E2E**: /esqueci-senha + /redefinir-senha + email HTML

### Fluxos validados em producao
- Compra: cart -> checkout PIX -> CAS-2026-000001 -> review com COMPRA VERIFICADA
- Q&A bidirecional: pergunta no PDP -> seller responde via /seller/qna
- Reports: criacao + moderacao admin
- Password reset: forgot -> notification email -> reset com revoke de sessoes

### Storefront (22 paginas publicas)
- Auth (4): /login, /register, /esqueci-senha, /redefinir-senha
- Catalogo (4): /, /products, /product/[slug], /status
- Sellers (2): /sellers, /seller/[slug]
- Compra (4): /cart, /checkout, /conta/pedidos, /conta/pedidos/[id], /conta/downloads/[token]
- Conta (3): /conta, /conta/seguranca, /conta/pedidos
- Institucional (4): /sobre, /termos, /privacidade, /cloud-code-ilimitado
- SEO (2): /robots.txt, /sitemap.xml

### Admin (9 pages) + Seller (6 pages) - todos com endpoints reais

### Componentes globais (10)
Nav, Footer, Providers, CartDrawer, AddToCart, ReviewForm, QnaForm, SearchAutocomplete, HeroAnimated, ProductCard

### Backend (16 services Swarm UP)
Gateway com pathRewrite + 12 svcs Node + qa-worker Python + 3 fronts

### SEO + Infra
- robots.txt + sitemap.xml dinamico
- SSL Lets Encrypt R13 auto-renew
- Backup pg_dump cron 6h + retencao 7d

### PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
