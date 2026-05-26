# progress.md - V1 PUBLICA + E2E VALIDADO

## STATUS FINAL: PRODUCAO PUBLICA - AGUARDANDO APENAS DNS

### VALIDADO HTTPS (via --resolve Host header, IP 209.145.60.53)

**Storefront** https://cas.inovareinteligenciaartificial.com
- Home / mostra: "Mais vendidos" + 10 produtos + "Mais buscados na semana" + Categorias + CTA seller
- /products lista 10 produtos com filtros+sort
- /product/[slug] PDP completo com tabs (Visao/Pre-requisitos/Changelog/Reviews/Q&A), sticky sidebar com preco, botoes Comprar + Adicionar carrinho
- /login + /register com 2FA flow
- /cart + /checkout (3 metodos PIX/Cartao/Boleto)
- /conta + /conta/seguranca (UI 2FA TOTP completa)

**Admin** https://admin.cas.inovareinteligenciaartificial.com  
- Sidebar com 10 secoes: Visao Geral (KPIs live 10s), Sellers (KYC), Produtos, QA Queue, Pedidos, Saques, Denuncias, Alertas, Vault

**Seller** https://seller.cas.inovareinteligenciaartificial.com
- Sidebar 6 secoes: Visao Geral (cronometro SLA), Meus produtos, Novo produto (upload multer), Q&A, Financeiro (payouts), Minha loja (KYC)

**API** https://api.cas.inovareinteligenciaartificial.com
- /api/status -> upstreams
- /api/auth/login -> JWT 15min validado
- /api/products, /api/search, /api/search/categories, /api/aiops/status

### SSL
- Issuer: Lets Encrypt R13
- Valid: May 26 -> Aug 24 2026 (auto-renew Traefik)

### Demo data
- Admin: fabricadeautomacoes0@gmail.com / ChangeMe!2026Inovare
- 10 produtos platform_owned com vendas/ratings simulados

### UNICA PENDENCIA
Configurar DNS A records -> 209.145.60.53:
- cas.inovareinteligenciaartificial.com
- api.cas.inovareinteligenciaartificial.com
- admin.cas.inovareinteligenciaartificial.com
- seller.cas.inovareinteligenciaartificial.com
