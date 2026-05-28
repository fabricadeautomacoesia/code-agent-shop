'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const { logger, sanitize, errorHandler } = require('@cas/shared');
const { healthcheck } = require('@cas/db-client');

const log = logger.child({ svc: 'seller-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_SELLER || '3011', 10);

app.disable('x-powered-by');
/* FIX-WORKER-17 pass 305: trust proxy paridade cross-svc (pass anterior gateway 304).
   PRE-FIX: req.ip = gateway internal IP (não real client) -> audit_log.ip
   inutil para forensics (todos events do mesmo gateway IP).
   Auth/payment/product/search/vault ja tinham este fix. Seller/notif/order
   estavam sem - inconsistencia DLP/audit cross-svc.
   POST-FIX: trust proxy=1 (1 hop = Traefik -> gateway -> seller-svc).
   req.ip agora le X-Forwarded-For correto. */
app.set('trust proxy', 1);
app.use(express.json({ limit: '512kb' }));
app.use(sanitize.middleware());

// FIX-WORKER-12 pass 3: alias /sellers/health (gateway /api/sellers/* -> /sellers/*)
const _healthHandler = async (_req, res) => res.json({ ok: true, db: await healthcheck() });
app.get('/health', _healthHandler);
app.get('/sellers/health', _healthHandler);

// MLB-4: loyalty (montado em /loyalty - mas gateway proxia via /api/loyalty)
app.use('/loyalty',       require('./routes/loyalty'));

// ORDEM IMPORTA: rotas especificas ANTES de /sellers (que captura :slug)
app.use('/sellers/me',    require('./routes/me'));
app.use('/sellers/admin', require('./routes/admin'));
app.use('/sellers',       require('./routes/sellers'));

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

// SLA cron diario - verifica deadlines Classe B
require('./cron/sla-checker').start();

const server = app.listen(PORT, () => log.info({ port: PORT }, '[seller-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
