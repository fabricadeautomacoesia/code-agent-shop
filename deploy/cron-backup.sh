#!/usr/bin/env bash
# cron-backup.sh - backup automatico do PostgreSQL code_agent_shop
# Roda a cada 6h via crontab. Retencao 7 dias (V8 6.2).
# Setup:
#   crontab -e
#   0 */6 * * * /opt/cas/deploy/cron-backup.sh >> /var/log/cas-backup.log 2>&1

set -e

BACKUP_DIR="/var/backups/cas"
RETENTION_DAYS=7
PG_CONTAINER=$(docker ps -qf name=postegresp2 | head -1)
PG_USER="postgres"
PG_PASS="58cf114a50f1b151e2c389c835c1b2d0"
PG_DB="code_agent_shop"

mkdir -p "$BACKUP_DIR"

TS=$(date +%Y-%m-%d_%H-%M-%S)
DUMP_FILE="$BACKUP_DIR/cas-$TS.sql.gz"

echo "[$(date)] backup start -> $DUMP_FILE"

# Dump dentro do container e gzip no host
docker exec -e PGPASSWORD="$PG_PASS" "$PG_CONTAINER" \
  pg_dump -U "$PG_USER" -d "$PG_DB" --no-owner --clean --if-exists | gzip > "$DUMP_FILE"

SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "[$(date)] backup OK: $DUMP_FILE ($SIZE)"

# Retencao 7 dias
DELETED=$(find "$BACKUP_DIR" -name "cas-*.sql.gz" -mtime +$RETENTION_DAYS -delete -print | wc -l)
[ "$DELETED" -gt 0 ] && echo "[$(date)] cleanup: removed $DELETED old backup(s)"

echo "[$(date)] backup DONE"
