'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const { logger, sanitize, errorHandler, startup } = require('@cas/shared');
const { healthcheck } = require('@cas/db-client');

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
app.use(express.json({ limit: '256kb' }));
app.use(sanitize.middleware());

app.get('/health', async (_req, res) => res.json({ ok: true, db: await healthcheck() }));

// ORDEM IMPORTA: especificas antes de /orders (que captura :id)
app.use('/orders/cart',     require('./routes/cart'));
app.use('/orders/download', require('./routes/download'));
app.use('/orders',          require('./routes/orders'));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[order-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
