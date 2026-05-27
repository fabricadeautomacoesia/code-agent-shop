# Asaas Production Token Setup

## Status atual (2026-05-27)

Token de produção Asaas validado:
- API: `https://api.asaas.com/v3` (PRODUÇÃO, não sandbox)
- Conta: CPF `01532667248`, Email `Emersonjosiel649@gmail.com`
- Cidade: Capitão Poço/PA
- Validação: `curl /v3/myAccount` retornou 200 com dados da conta

## Como aplicar na VPS

**IMPORTANTE:** O token NÃO está no git (`.env` em `.gitignore`).
Aplicar via SSH na VPS `server2.inovareinteligenciaartificial.com`:

```bash
# 1. SSH na VPS
ssh root@server2.inovareinteligenciaartificial.com

# 2. Exportar token (NÃO comitar no git!)
export ASAAS_API_KEY='$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OjkyZmU3MzVhLWQ1YjItNGI0Ni1hYzRhLWU2MDAxZTRiMDgzNjo6JGFhY2hfNTg3MjVjNTctMGJjNS00MWMwLWFiOTAtNDMwYmRiMzc4ODkx'

# 3. Rodar script de update (idempotente, cria backup do .env)
cd /opt/cas
bash deploy/asaas-token-update.sh

# 4. Validar publicamente
curl https://cas.inovareinteligenciaartificial.com/api/payments/health
# Esperado: {"ok":true,"asaas":{"configured":true,"url":"https://api.asaas.com/v3"},...}
```

## O que o script faz

1. **Backup automático** do `.env` com timestamp (`.env.bak.20260527_143000`)
2. **Upsert** `ASAAS_API_KEY=...` no `/opt/cas/.env`
   - Se já existe: substitui
   - Se não existe: adiciona
3. **Garante** `ASAAS_API_URL=https://api.asaas.com/v3` (produção, não sandbox)
4. **Restart** automático do `payment-svc` via `docker service update --force`

## Rollback

```bash
# Listar backups
ls /opt/cas/.env.bak.*

# Restaurar último
cp /opt/cas/.env.bak.20260527_143000 /opt/cas/.env
docker service update --force cas_payment-svc
```

## Configurar Webhook Asaas (próximo passo)

Após o token funcionando, configurar webhook no painel Asaas:

1. Painel Asaas → Integrações → Webhooks
2. URL: `https://cas.inovareinteligenciaartificial.com/api/payments/asaas/webhook`
3. Versão API: v3
4. Eventos: marcar todos relevantes (PAYMENT_CREATED, PAYMENT_RECEIVED, PAYMENT_CONFIRMED, PAYMENT_REFUNDED)
5. Secret: gerar string aleatória 32+ chars, salvar em `ASAAS_WEBHOOK_SECRET` no `.env`

```bash
# Gerar secret seguro
openssl rand -hex 32
# Exemplo: a1b2c3d4...

# Adicionar ao .env (mesma forma do token):
export ASAAS_WEBHOOK_SECRET='<secret_gerado>'
# (script asaas-token-update.sh pode ser estendido para adicionar webhook secret tambem)
```

## Smoke test E2E pós-deploy

```bash
# 1. Health check
curl -s https://cas.inovareinteligenciaartificial.com/api/payments/health | jq

# 2. Installments preview (não precisa auth)
curl -s 'https://cas.inovareinteligenciaartificial.com/api/payments/installments/preview?amount_cents=10000' | jq

# 3. Login + checkout E2E
# (com user teste1@cas.io / Teste123 - CPF cadastrado obrigatório)
```

## Notas de segurança

- Token é **production live** — qualquer transação cria cobrança real
- Recomenda-se **separar tokens** (`ASAAS_API_KEY_SANDBOX` para dev local)
- Token tem permissão TOTAL: criar customers, payments, transfers, split
- **Rotacionar token** a cada 90 dias mínimo (Asaas → Integrações → API Keys)
- Logs do payment-svc: `[asaas.err]` mostra apenas status + path, **nunca** access_token
