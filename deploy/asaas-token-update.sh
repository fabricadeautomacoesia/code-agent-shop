#!/usr/bin/env bash
# deploy/asaas-token-update.sh - Atualiza ASAAS_API_KEY no .env de producao
#
# IMPORTANTE: este script NAO contem o token (mantido em git).
# Token deve ser exportado como env var ASAAS_API_KEY antes de executar:
#   export ASAAS_API_KEY='$aact_prod_...'
#   bash deploy/asaas-token-update.sh
#
# Idempotente: pode rodar varias vezes. Cria backup do .env antes.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/cas/.env}"

if [ -z "${ASAAS_API_KEY:-}" ]; then
  echo "[ERROR] export ASAAS_API_KEY antes de rodar este script"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "[ERROR] $ENV_FILE nao encontrado"
  exit 1
fi

# Backup atomico com timestamp
BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d_%H%M%S)"
cp -a "$ENV_FILE" "$BACKUP"
echo "[OK] Backup criado: $BACKUP"

# Upsert ASAAS_API_KEY (replace se ja existe, senao append)
if grep -q '^ASAAS_API_KEY=' "$ENV_FILE"; then
  # macOS sed vs Linux sed: usar -i.tmp para compat (Linux ignora .tmp)
  sed -i.tmp "s|^ASAAS_API_KEY=.*|ASAAS_API_KEY=${ASAAS_API_KEY}|" "$ENV_FILE"
  rm -f "${ENV_FILE}.tmp"
  echo "[OK] ASAAS_API_KEY atualizado em $ENV_FILE"
else
  echo "ASAAS_API_KEY=${ASAAS_API_KEY}" >> "$ENV_FILE"
  echo "[OK] ASAAS_API_KEY adicionado em $ENV_FILE"
fi

# Garante URL producao (caso esteja em sandbox)
if grep -q '^ASAAS_API_URL=' "$ENV_FILE"; then
  sed -i.tmp 's|^ASAAS_API_URL=.*|ASAAS_API_URL=https://api.asaas.com/v3|' "$ENV_FILE"
  rm -f "${ENV_FILE}.tmp"
else
  echo 'ASAAS_API_URL=https://api.asaas.com/v3' >> "$ENV_FILE"
fi
echo "[OK] ASAAS_API_URL=https://api.asaas.com/v3 (PRODUCAO)"

# Restart apenas do payment-svc (carrega novo .env)
if command -v docker >/dev/null 2>&1; then
  echo "[INFO] Forcando update do payment-svc no Swarm..."
  docker service update --force cas_payment-svc 2>/dev/null || \
    docker compose -f /opt/cas/deploy/docker-compose.yml restart payment-svc 2>/dev/null || \
    echo "[WARN] Update manual necessario - rode: docker service update --force cas_payment-svc"
fi

echo "[DONE] Para validar: curl https://cas.inovareinteligenciaartificial.com/api/payments/health"
