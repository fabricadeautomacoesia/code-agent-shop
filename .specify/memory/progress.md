# progress.md - V1 OPERACIONAL FULL-STACK

## STATUS: PRODUCAO COMPLETA - AGUARDANDO DNS

### Capacidades comerciais validadas
- Compra com 3 metodos pagamento (PIX/Boleto/Cartao) via Asaas
- Carrinho persistente + cupons + remove + CartDrawer lateral
- Checkout 1-click com retry no payment
- Download de produto pago com license_key + expiracao 365d
- Pedidos com snapshot do produto + items_preview

### Capacidades de relacionamento
- Q&A publica no PDP (compradores perguntam)
- Seller responde pelo dashboard /qna (notifica quem perguntou)
- Reviews verificadas (com order_id) + replies do seller
- Reports/denuncias por compradores (admin modera)
- Disputes/disputas formais (mediacao via dispute_messages)

### Capacidades para vendedor
- Cronometro SLA Classe B (warnings 7d/3d/1d + revogacao auto)
- Upload de produto com QA automatizado LLM
- Versionamento de produto (changelog)
- Painel financeiro com receita liquida 82%
- Solicitar payout via Asaas

### Capacidades admin (master console)
- KPIs live polling 10s (CPU/RAM/Disk + alerts)
- Sellers: KYC + suspend + promote Classe B
- QA queue + force-approve + Clausula Master (platform-take)
- Orders + stats (count_paid, count_pending, total_revenue)
- Payouts approve/reject + processar Asaas transfer
- Reports moderation
- Vault de API keys AES-256-GCM (provisionar + revogar)

### SEO completo (Google ready)
- /robots.txt com allow/disallow + sitemap reference
- /sitemap.xml dinamico (produtos + sellers + estaticas)
- Metadata OG pt-BR
- URLs canonicas + slug semantico

### Seguranca (V8)
- JWT duplo (15min access + 7d refresh HTTP-only)
- Cookie cross-subdomain .cas.inovareinteligenciaartificial.com
- Refresh rotation + blacklist + auto-refresh silencioso em 401
- 2FA TOTP com QR + recovery codes + senha+token para disable
- Fail2Ban in-memory (5 falhas = ban 15min)
- Vault AES-256-GCM + spike detector + helmet CSP

### Infra
- 16 services Swarm UP (12 Node + qa-worker Python + 3 fronts)
- Traefik + SSL Lets Encrypt R13 auto-renew
- Postgres 14 (reusado) + Redis 7
- Backup cron 6h + retencao 7d (47KB/dump)

### PENDENCIA UNICA: DNS A pelo usuario
- cas, api.cas, admin.cas, seller.cas .inovareinteligenciaartificial.com -> 209.145.60.53
