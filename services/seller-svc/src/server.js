'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const { logger, sanitize, errorHandler } = require('@cas/shared');
const { healthcheck } = require('@cas/db-client');

const log = logger.child({ svc: 'seller-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_SELLER || '3011', 10);

app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));
app.use(sanitize.middleware());

app.get('/health', async (_req, res) => res.json({ ok: true, db: await healthcheck() }));

app.use('/sellers',      require('./routes/sellers'));
app.use('/sellers/me',   require('./routes/me'));
app.use('/sellers/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

// SLA cron diario - verifica deadlines Classe B
require('./cron/sla-checker').start();

const server = app.listen(PORT, () => log.info({ port: PORT }, '[seller-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
