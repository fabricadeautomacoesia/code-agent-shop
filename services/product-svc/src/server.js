'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const { logger, sanitize, errorHandler } = require('@cas/shared');
const { healthcheck } = require('@cas/db-client');

const log = logger.child({ svc: 'product-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_PRODUCT || '3012', 10);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(sanitize.middleware());

app.get('/health', async (_req, res) => res.json({ ok: true, db: await healthcheck() }));

// ORDEM IMPORTA: rotas especificas ANTES de /products generico (que captura :slug)
app.use('/products/me',       require('./routes/seller-mgmt'));
app.use('/products/admin',    require('./routes/admin'));
app.use('/products/upload',   require('./routes/upload'));
app.use('/products',          require('./routes/public'));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[product-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
