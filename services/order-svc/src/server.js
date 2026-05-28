'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const { logger, sanitize, errorHandler, startup, mask } = require('@cas/shared');
const { query, healthcheck } = require('@cas/db-client');

// FIX-WORKER-17 pass 8: order-svc faz fetch para payment-svc/qa-svc com
// x-internal-token. Sem PAYMENT_INTERNAL_TOKEN configurado, dispatch silencioso 401
// (W2 pass 3 root cause). enforceInProd warn periodico ate ops configurar.
startup.validateStartupEnv({
  critical: ['PG_PASS'],
  minLength: { PG_PASS: 12 },
  enforceInProd: ['PAYMENT_INTERNAL_TOKEN'],
});

const log = logger.child({ svc: 'order-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_ORDER || '3015', 10);

app.disable('x-powered-by');
/* FIX-WORKER-17 pass 305: trust proxy paridade cross-svc */
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(sanitize.middleware());

app.get('/health', async (_req, res) => res.json({ ok: true, db: await healthcheck() }));

// ORDEM IMPORTA: especificas antes de /orders (que captura :id)
app.use('/orders/cart',     require('./routes/cart'));
app.use('/orders/download', require('./routes/download'));
app.use('/orders',          require('./routes/orders'));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

// FIX-WORKER-14 pass 4: abandon-cart cleanup cron usa idx_carts_expires_cleanup (mig 031).
// Roda a cada 6h em PROD (overkill mas barato com idx). DELETE em cascade limpa cart_items via FK.
//
// Window:
// - Carts com expires_at definido (orders sem checkout completo) E < NOW - 7d -> DELETE
// - Carts user-bound sem expires_at NAO sao tocados (user pode voltar dias depois)
//
// Em prod high-traffic: cleanup pode rodar mais frequente (1h) para liberar Redis cart_items refs.
const CART_CLEANUP_INTERVAL_MS = parseInt(process.env.CART_CLEANUP_INTERVAL_MS || '21600000', 10); // 6h default
const CART_CLEANUP_DAYS = parseInt(process.env.CART_CLEANUP_DAYS || '7', 10);

async function cleanupAbandonedCarts() {
  try {
    const r = await query(
      `DELETE FROM carts
         WHERE expires_at IS NOT NULL
           AND expires_at < NOW() - ($1 || ' days')::INTERVAL
         RETURNING id`,
      [String(CART_CLEANUP_DAYS)]
    );
    if (r.rowCount > 0) {
      log.info({ deleted: r.rowCount, days: CART_CLEANUP_DAYS }, '[cart.cleanup]');
    }
  } catch (e) {
    /* FIX-WORKER-2 pass 342: DLP mask cart cleanup error */
    log.error({ err: mask.text(String(e.message || '').slice(0, 300)) }, '[cart.cleanup.fail]');
  }
}

// Roda 30s apos startup (warmup) + agendado
setTimeout(cleanupAbandonedCarts, 30000);
setInterval(cleanupAbandonedCarts, CART_CLEANUP_INTERVAL_MS).unref();

const server = app.listen(PORT, () => log.info({ port: PORT, cleanup_interval_h: CART_CLEANUP_INTERVAL_MS / 3600000 }, '[order-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
