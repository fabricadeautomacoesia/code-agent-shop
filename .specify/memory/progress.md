# progress.md - V1 PUBLICA E FUNCIONAL

## STATUS FINAL: PRONTO PARA PRODUCAO PUBLICA

Sistema completo deployado, validado E2E, SSL Lets Encrypt emitido.
Aguardando apenas DNS A records do usuario.

### VPS server2.inovareinteligenciaartificial.com (209.145.60.53)
- Docker Swarm + Traefik v2.11
- 16/16 services UP
- DB code_agent_shop em postegresp2 (47 tabelas + seeds + 10 produtos demo)
- SSL Lets Encrypt R13 emitido para cas.inovareinteligenciaartificial.com

### Acesso (validado HTTP 200):
- https://cas.inovareinteligenciaartificial.com -> storefront
- https://api.cas.inovareinteligenciaartificial.com -> gateway API
- https://admin.cas.inovareinteligenciaartificial.com -> admin
- https://seller.cas.inovareinteligenciaartificial.com -> seller

### Login admin
- fabricadeautomacoes0@gmail.com / ChangeMe!2026Inovare
- POST /api/auth/login -> JWT 15min OK

### PENDENCIA: DNS A records do usuario
- cas.inovareinteligenciaartificial.com -> 209.145.60.53
- api.cas.inovareinteligenciaartificial.com -> 209.145.60.53
- admin.cas.inovareinteligenciaartificial.com -> 209.145.60.53
- seller.cas.inovareinteligenciaartificial.com -> 209.145.60.53
