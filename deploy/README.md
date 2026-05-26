# Deploy - Code & Agent Shop

Tres modos de deploy suportados:

## 1) DEV LOCAL (Docker Compose)

```bash
cp .env.example .env
# editar .env com chaves Asaas, SMTP, OpenAI/Gemini/Groq, JWT secrets

docker compose -f deploy/docker-compose.yml up -d

# Apos containers up:
docker compose exec gateway sh -c "cd /app && node bin/migrate.js && node bin/seed.js"
```

Endpoints locais:
- Storefront: http://localhost:3000
- Admin: http://localhost:3001
- Seller: http://localhost:3003
- Gateway API: http://localhost:3002
- AIOps Status: http://localhost:3006/status

## 2) DEV nativo (sem Docker)

```bash
# Requer Postgres + Redis locais
npm install
npm run db:migrate
npm run db:seed
node bin/dev-all.js   # sobe os 12 svcs + 3 fronts + qa-worker.py
```

## 3) PRODUCAO Swarm + Traefik

Pre-requisitos no nó manager:
```bash
docker swarm init
docker network create -d overlay --attachable network_swarm_public

# Volumes externos (V8 §1)
docker volume create node_datad
docker volume create php82_datad
docker volume create python_datad

# Traefik + Portainer ja rodando, com certresolver=letsencryptresolver configurado.
```

### Build + push das imagens

```bash
# defina REGISTRY (ex: registry.suaempresa.com.br/cas) e TAG
export REGISTRY=registry.actionplandigital.com.br/cas
export TAG=$(git rev-parse --short HEAD)

# Build (loop) - cada svc usa Dockerfile.node com ARG SVC
for svc in gateway auth-svc vault-svc seller-svc product-svc qa-svc order-svc payment-svc review-svc notification-svc search-svc aiops-svc; do
  docker build --build-arg SVC=$svc -t $REGISTRY/cas-$svc:$TAG -f deploy/Dockerfile.node .
  docker push $REGISTRY/cas-$svc:$TAG
done

docker build -t $REGISTRY/cas-qa-worker:$TAG services/qa-worker
docker push $REGISTRY/cas-qa-worker:$TAG

for app in storefront dashboard-admin dashboard-seller; do
  short=$(echo $app | sed 's/dashboard-//')
  docker build -t $REGISTRY/cas-$short:$TAG -f deploy/Dockerfile.next apps/$app
  docker push $REGISTRY/cas-$short:$TAG
done
```

### Deploy stack

```bash
docker stack deploy -c deploy/stack.yml --with-registry-auth cas
docker stack services cas
docker stack ps cas --no-trunc
```

### Apos primeiro deploy

```bash
# Migrations no manager
docker exec $(docker ps -qf name=cas_gateway) node bin/migrate.js
docker exec $(docker ps -qf name=cas_gateway) node bin/seed.js
```

### Dominios (configurar DNS A apontando para o IP do manager)
- code-agent-shop.com.br        -> storefront
- www.code-agent-shop.com.br    -> storefront
- admin.code-agent-shop.com.br  -> dashboard-admin
- seller.code-agent-shop.com.br -> dashboard-seller
- api.code-agent-shop.com.br    -> gateway

## 4) ALTERNATIVA PM2 (sem Docker, deploy bare-metal)

```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup     # cria systemd para boot automatico
pm2 logs        # acompanhar
pm2 monit       # dashboard TUI
```

## Smoke tests

```bash
npm run smoke   # node bin/smoke-tests.js
```

Saida esperada (todos OK):
```
[1/2] PostgreSQL... OK
[2/2] Microservicos:
  OK   [gateway        ] 23ms
  OK   [auth-svc       ] 15ms
  ... (13 total)
=== RESUMO ===
  DB:      OK
  Svcs OK: 13/13
```

## Backups automatizados

```bash
# Adicionar ao crontab do manager:
0 */6 * * * cd /opt/cas && node bin/backup.js  # a cada 6h
```

## Rollback

```bash
docker stack rm cas
# re-deploy com TAG anterior
TAG=<sha-anterior> docker stack deploy -c deploy/stack.yml cas
```
