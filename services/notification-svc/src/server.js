'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const express = require('express');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { logger, sanitize, errorHandler, asyncHandler, validate, jwt, mask } = require('@cas/shared');

const log = logger.child({ svc: 'notification-svc' });
const app = express();
const PORT = parseInt(process.env.PORT_NOTIFICATION || '3018', 10);

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(sanitize.middleware());

// ============================================================
// Transports
// ============================================================
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const FROM = process.env.SMTP_FROM || 'Code & Agent Shop <no-reply@code-agent-shop.com>';

async function sendEmail(to, subject, body, html) {
  return mailer.sendMail({ from: FROM, to, subject, text: body, html: html || undefined });
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return null;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: message.slice(0, 4000), parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(10000),
  });
  return r.json();
}

// ============================================================
// Endpoints
// ============================================================
app.get('/health', (_req, res) => res.json({
  ok: true, svc: 'notification-svc',
  channels: { email: !!process.env.SMTP_HOST, telegram: !!process.env.TELEGRAM_BOT_TOKEN }
}));

// GET /api/notifications - bandeja in-app do user
app.get('/', jwt.requireAuth(), asyncHandler(async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const r = await query(
    `SELECT * FROM notifications
      WHERE user_id = $1 AND channel = 'in_app'
      ORDER BY created_at DESC LIMIT $2`,
    [req.user.sub, lim]
  );
  res.json({ notifications: r.rows });
}));

// POST /api/notifications/:id/read
app.post('/:id/read', jwt.requireAuth(), asyncHandler(async (req, res) => {
  await query(
    `UPDATE notifications SET is_read = TRUE, read_at = NOW()
      WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.sub]
  );
  res.json({ ok: true });
}));

// POST /api/notifications/test - admin envia teste
app.post('/test', jwt.requireAuth({ roles: ['admin'] }),
  validate({ body: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }) }),
  asyncHandler(async (req, res) => {
    const info = await sendEmail(req.body.to, req.body.subject, req.body.body);
    res.json({ ok: true, messageId: info.messageId });
  })
);

// ============================================================
// PROCESSOR (worker cron)
// ============================================================
async function processOutbox() {
  const pending = await query(
    `SELECT n.id, n.user_id, n.channel, n.template_code, n.title, n.body, n.body_html,
            n.priority, n.payload, u.email, u.full_name, u.locale
       FROM notifications n
       JOIN users u ON u.id = n.user_id
      WHERE n.sent_status = 'pending'
        AND n.channel IN ('email','telegram')
        AND n.retry_count < 5
      ORDER BY n.priority DESC, n.created_at ASC LIMIT 50`
  );

  for (const n of pending.rows) {
    try {
      let info;
      if (n.channel === 'email') {
        info = await sendEmail(n.email, n.title, n.body, n.body_html);
      } else if (n.channel === 'telegram') {
        info = await sendTelegram(`*${n.title}*\n${n.body}`);
      }
      await query(
        `UPDATE notifications SET sent_status = 'sent', sent_at = NOW() WHERE id = $1`,
        [n.id]
      );
      log.info({ id: n.id, channel: n.channel, to: mask.text(n.email || '') }, '[notif.sent]');
    } catch (e) {
      log.warn({ id: n.id, err: e.message }, '[notif.fail]');
      await query(
        `UPDATE notifications SET retry_count = retry_count + 1,
                                  failed_reason = $1,
                                  sent_status = CASE WHEN retry_count + 1 >= 5 THEN 'failed' ELSE 'pending' END
          WHERE id = $2`,
        [e.message.slice(0, 500), n.id]
      );
    }
  }
}

// Cron: a cada 30s processa outbox
cron.schedule('*/30 * * * * *', () => processOutbox().catch((e) => log.error({ err: e.message }, '[outbox.err]')));

// Cron diario: limpeza de notifications antigas (60d)
cron.schedule('0 4 * * *', async () => {
  const r = await query(`DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '60 days' RETURNING id`);
  log.info({ deleted: r.rowCount }, '[notif.cleanup]');
});

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[notification-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
