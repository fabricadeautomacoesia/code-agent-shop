#!/usr/bin/env bash
# vps-bootstrap.sh - executado na VPS para preparar deploy
# Uso (na VPS): bash deploy/vps-bootstrap.sh
set -e

REPO="https://github.com/fabricadeautomacoesia/code-agent-shop.git"
ROOT="/opt/cas"
PG_CONTAINER="$(docker ps -qf name=postegresp2 | head -1)"
PG_USER="postgres"
PG_PASS="58cf114a50f1b151e2c389c835c1b2d0"
PG_DB="code_agent_shop"

echo "═══════════════════════════════════════════════"
echo "  CAS Bootstrap - $(date)"
echo "═══════════════════════════════════════════════"

# 1) Clone/update repo
if [ ! -d "$ROOT/.git" ]; then
  echo "[1/6] git clone..."
  mkdir -p "$ROOT"
  git clone "$REPO" "$ROOT"
else
  echo "[1/6] git pull..."
  cd "$ROOT" && git fetch && git reset --hard origin/main
fi
cd "$ROOT"

# 2) Criar DB no Postgres existente (se nao existir)
echo "[2/6] DB setup..."
docker exec -e PGPASSWORD="$PG_PASS" "$PG_CONTAINER" psql -U "$PG_USER" -tc "SELECT 1 FROM pg_database WHERE datname='$PG_DB'" | grep -q 1 \
  || docker exec -e PGPASSWORD="$PG_PASS" "$PG_CONTAINER" psql -U "$PG_USER" -c "CREATE DATABASE $PG_DB"
echo "    DB $PG_DB OK"

# 3) .env producao
if [ ! -f "$ROOT/.env" ]; then
  echo "[3/6] criando .env (template)..."
  cp "$ROOT/deploy/.env.production.template" "$ROOT/.env"
  # Gerar secrets randomicos
  JA=$(openssl rand -hex 32)
  JR=$(openssl rand -hex 32)
  VA=$(openssl rand -hex 32)
  AW=$(openssl rand -hex 32)
  sed -i "s|__GERAR_64HEX__|$JA|" "$ROOT/.env"     # 1a ocorrencia JWT_ACCESS_SECRET
  sed -i "0,/__GERAR_64HEX__/s|__GERAR_64HEX__|$JR|" "$ROOT/.env"
  sed -i "0,/__GERAR_64HEX__/s|__GERAR_64HEX__|$VA|" "$ROOT/.env"
  sed -i "0,/__GERAR_64HEX__/s|__GERAR_64HEX__|$AW|" "$ROOT/.env"
  echo "    .env criado. EDITAR antes de deploy para preencher chaves externas (Asaas, LLM, SMTP, Telegram chat_id)."
else
  echo "[3/6] .env ja existe, mantendo..."
fi

# 4) Build imagens Docker (sem Swarm ainda - apenas build local)
echo "[4/6] docker build (12 svcs + qa-worker + 3 fronts)..."
cd "$ROOT"
for svc in gateway auth-svc vault-svc seller-svc product-svc qa-svc order-svc payment-svc review-svc notification-svc search-svc aiops-svc; do
  echo "  building cas-$svc ..."
  docker build --build-arg SVC=$svc -t localhost/cas-$svc:latest -f deploy/Dockerfile.node . 2>&1 | tail -3
done
echo "  building cas-qa-worker ..."
docker build -t localhost/cas-qa-worker:latest services/qa-worker 2>&1 | tail -3

for app in storefront dashboard-admin dashboard-seller; do
  short=$(echo $app | sed 's/dashboard-//')
  echo "  building cas-$short ..."
  docker build -t localhost/cas-$short:latest -f deploy/Dockerfile.next apps/$app 2>&1 | tail -3
done

# 5) Run migrations
echo "[5/6] migrations..."
docker run --rm \
  --network minha_rede \
  -v "$ROOT:/app" \
  -w /app \
  --env-file .env \
  -e PG_HOST=postegresp2 \
  node:20-alpine sh -c "npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3 && node bin/migrate.js && node bin/seed.js"

# 6) Deploy stack
echo "[6/6] docker stack deploy..."
docker stack deploy -c deploy/stack.inovare.yml cas
sleep 5
docker stack services cas | head

echo ""
echo "═══════════════════════════════════════════════"
echo "  Bootstrap COMPLETO!"
echo "  Acesso temporario (sem DNS ainda):"
echo "    https://cas.inovareinteligenciaartificial.com"
echo "    https://admin.cas.inovareinteligenciaartificial.com"
echo "    https://seller.cas.inovareinteligenciaartificial.com"
echo "    https://api.cas.inovareinteligenciaartificial.com/api/status"
echo "  Aponte DNS A dos 4 subdominios para o IP da VPS"
echo "═══════════════════════════════════════════════"
