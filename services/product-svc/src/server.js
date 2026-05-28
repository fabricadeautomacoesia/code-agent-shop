'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const path = require('node:path');
const { logger, sanitize, errorHandler, mask } = require('@cas/shared');
const { healthcheck } = require('@cas/db-client');

const log = logger.child({ svc: 'product-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_PRODUCT || '3012', 10);

app.disable('x-powered-by');
// FIX-WORKER-10 pass 7: trust proxy 1 - req.ip pega X-Forwarded-For do gateway.
// Necessario para rateLimiter funcionar com IP real (vs IP do load balancer interno Swarm).
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(sanitize.middleware());

// FIX-WORKER-12 pass 3: alias /products/health (gateway /api/products/* -> /products/*)
const _healthHandler = async (_req, res) => res.json({ ok: true, db: await healthcheck() });
app.get('/health', _healthHandler);
app.get('/products/health', _healthHandler);

// SERVIR arquivos uploaded publicamente (cover_image_url + downloads)
// Path: /uploads/<filename> -> /app/uploads/<filename>
const UPLOAD_DIR = process.env.STORAGE_LOCAL_PATH || path.join(__dirname, '../../../uploads');
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  immutable: true,
  fallthrough: true,
  dotfiles: 'deny',
}));

// ORDEM IMPORTA: rotas especificas ANTES de /products generico (que captura :slug)
app.use('/products/me',         require('./routes/seller-mgmt'));
app.use('/products/admin',      require('./routes/admin'));
app.use('/products/upload',     require('./routes/upload'));
app.use('/products/wishlist',   require('./routes/wishlist'));
// MLB-12 NEW: price drop alerts ("Avise-me se baixar")
app.use('/products/price-alerts', require('./routes/price-alerts'));
app.use('/products',            require('./routes/public'));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

// ============================================================
// FIX-WORKER-18 pass 7: rolling 90d/30d partial idx rotation (migration 041)
// ============================================================
// PG requer imutabilidade no WHERE de CREATE INDEX. NOW() nao IMMUTABLE.
// Solucao: idx parcial com data FIXA hardcoded + cron rotation semanal.
//
// Algoritmo (executa @weekly + 1min apos startup):
//   1. Calcula date_Nd = today - N days + 7d slack (queries cobertas)
//   2. CREATE INDEX CONCURRENTLY ..._new WHERE created_at > '<date>'
//   3. DROP CONCURRENTLY antigo
//   4. ALTER INDEX _new RENAME TO ..._Nd
//
// CONCURRENTLY: sem lock table - escrita continua durante rebuild.
// try-catch swallow: erro nao crasha svc (log warn, retry proxima semana).
async function rotateProductViewsRollingIdx() {
  const { query } = require('@cas/db-client');
  const today = new Date();

  // 90d window com 7d slack (queries WHERE > 90d cobertas pelo idx > 83d ate proxima rotacao)
  const date90d = new Date(today.getTime() - 83 * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);
  // 30d window com 7d slack (queries WHERE > 30d cobertas pelo idx > 23d)
  const date30d = new Date(today.getTime() - 23 * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);

  for (const { name, threshold, body } of [
    { name: '90d', threshold: date90d,
      body: `(user_id, created_at DESC) WHERE user_id IS NOT NULL AND created_at > '${date90d}'::TIMESTAMPTZ` },
    { name: '30d', threshold: date30d,
      body: `(user_id, product_id, created_at DESC) WHERE user_id IS NOT NULL AND created_at > '${date30d}'::TIMESTAMPTZ` },
  ]) {
    const idxOld = `idx_pviews_rolling_${name}`;
    const idxNew = `idx_pviews_rolling_${name}_new`;
    try {
      // 1. Cria novo CONCURRENTLY (sem lock)
      await query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${idxNew} ON product_views ${body}`);
      // 2. Drop antigo CONCURRENTLY (sem lock)
      await query(`DROP INDEX CONCURRENTLY IF EXISTS ${idxOld}`);
      // 3. Rename new -> primary
      await query(`ALTER INDEX IF EXISTS ${idxNew} RENAME TO ${idxOld}`);
      log.info({ idx: idxOld, threshold }, '[w18.pviews.rolling_rotated]');
    } catch (e) {
      log.warn({ /* FIX pass 344 DLP */ err: mask.text(String(e.message || '').slice(0, 300)), idx: idxOld }, '[w18.pviews.rolling_rotate_fail]');
    }
  }
}

// Executa 1min apos boot + a cada 7 dias (setInterval - sem dep node-cron)
setTimeout(() => rotateProductViewsRollingIdx().catch(() => {}), 60_000);
setInterval(() => rotateProductViewsRollingIdx().catch(() => {}), 7 * 24 * 3600 * 1000);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[product-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
