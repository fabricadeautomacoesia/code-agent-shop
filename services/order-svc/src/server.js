'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const { logger, sanitize, errorHandler } = require('@cas/shared');
const { healthcheck } = require('@cas/db-client');

const log = logger.child({ svc: 'order-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_ORDER || '3015', 10);

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(sanitize.middleware());

app.get('/health', async (_req, res) => res.json({ ok: true, db: await healthcheck() }));

app.use('/orders/cart',     require('./routes/cart'));
app.use('/orders',          require('./routes/orders'));
app.use('/orders/download', require('./routes/download'));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[order-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
