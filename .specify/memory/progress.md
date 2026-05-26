# progress.md - V1 OPERACIONAL + UI PREMIUM

## STATUS: PRODUCAO READY - AGUARDANDO DNS

### Auth com refresh silencioso (V8 21.6)
- 401 token_expired -> auto fetch /api/auth/refresh com cookie
- Salva novo access em zustand store
- Retry da request original com novo token
- Cross-subdomain (.cas.) funciona

### UI Premium (V8 §2, §15, §16)
- HeroAnimated: 4 cards 3D flutuantes com GSAP rotate continuo
- Mouse parallax na hero (V8 15.4 flashlight inspirado)
- Animate-glow-pulse orb central (V8 23.2)
- Reveal-up com ScrollTrigger
- Lenis smooth scroll
- Glassmorphism em todas as cards
- Noise overlay fixo

### Fluxos E2E em producao
| Fluxo | Validado |
|---|---|
| Register/login/refresh/logout | OK |
| Cart + checkout PIX | OK CAS-2026-000001 |
| Order detail + downloads | OK |
| Q&A no PDP | OK a8521fd1 |
| Report criacao + admin list | OK 63372209 |
| Admin orders recent + stats | OK |
| 2FA TOTP UI | OK |

### Backup pg_dump (V8 6.2)
- /opt/cas/deploy/cron-backup.sh ativo
- Cron 0 */6 * * *
- Retencao 7 dias
- 47KB por dump

### SSL
- Lets Encrypt R13 auto-renew
- 4 subdominios cobertos

### Storefront pages (13)
- /, /products, /product/[slug] (com QnaForm + HeroAnimated na home)
- /login, /register, /cart, /checkout
- /conta, /conta/pedidos, /conta/pedidos/[id], /conta/downloads/[token], /conta/seguranca

### PENDENCIA UNICA: DNS A
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
