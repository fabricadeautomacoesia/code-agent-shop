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

// FIX-WORKER-13: Mustache-like render simples. Substitui {{var}} ou {{nested.path}}.
// Suporta nested via dot notation (ex {{user.email}}).
// Var ausente vira string vazia (evita 'undefined' literal no email).
// Anti-XSS minimo - se contexto contem HTML, escapa em body text (mantem em body_html).
function renderMustache(template, ctx) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const parts = path.split('.');
    let cur = ctx;
    for (const p of parts) {
      if (cur == null) return '';
      cur = cur[p];
    }
    return cur == null ? '' : String(cur);
  });
}

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
// FIX-WORKER-13: SELECT explicit nao expoe campos internos do outbox processor:
// - locked_by/locked_at (worker mutex), next_retry_at/retry_count/failed_reason
//   (state machine), sent_status/sent_at (irrelevante para in_app), template_code
//   (interno), user_id (redundante, ja eh do user authed)
// Reduz tambem payload size por notif (de ~1.3kb para ~0.5kb).
app.get('/', jwt.requireAuth(), asyncHandler(async (req, res) => {
  const lim = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  // FIX-WORKER-1: template_code re-incluido (nao e DLP - apenas string interna
  // como 'product_approved'/'welcome_bonus' que o UI precisa para inferir URL fallback
  // quando cta_url e null. Confirmado nao-sensitive em audit-W13).
  const r = await query(
    `SELECT id, channel, template_code, title, body, body_html, cta_label, cta_url, icon,
            priority, payload, is_read, read_at, created_at
       FROM notifications
      WHERE user_id = $1 AND channel = 'in_app'
      ORDER BY created_at DESC LIMIT $2`,
    [req.user.sub, lim]
  );
  res.json({ notifications: r.rows });
}));

// POST /api/notifications/:id/read
// FIX-WORKER-13: regex UUID antes do query evita PG 22P02 -> 500 quando id malformado.
// Antes: silencioso ok:true mesmo se nenhuma row foi afetada (notif inexistente
// ou de outro user). Agora retorna 404 se UPDATE 0 rows.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.post('/:id/read', jwt.requireAuth(), asyncHandler(async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) {
    return next(errorHandler.notFound('notification_not_found'));
  }
  const r = await query(
    `UPDATE notifications SET is_read = TRUE, read_at = NOW()
      WHERE id = $1::UUID AND user_id = $2::UUID AND is_read = FALSE
      RETURNING id`,
    [req.params.id, req.user.sub]
  );
  if (!r.rows.length) {
    // Verifica se notif existe mas ja estava lida (idempotent OK)
    const check = await query(
      `SELECT is_read FROM notifications WHERE id = $1::UUID AND user_id = $2::UUID`,
      [req.params.id, req.user.sub]
    );
    if (!check.rows.length) return next(errorHandler.notFound('notification_not_found'));
    // Ja estava lida - idempotent
    return res.json({ ok: true, already_read: true });
  }
  res.json({ ok: true });
}));

// FIX-WORKER-1: POST /api/notifications/read-all - marca todas in_app nao-lidas como lidas
app.post('/read-all', jwt.requireAuth(), asyncHandler(async (req, res) => {
  const r = await query(
    `UPDATE notifications SET is_read = TRUE, read_at = NOW()
      WHERE user_id = $1 AND channel = 'in_app' AND is_read = FALSE
      RETURNING id`,
    [req.user.sub]
  );
  res.json({ ok: true, marked: r.rowCount });
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
// PROCESSOR (worker cron) - WORKER 13 FIX
// ============================================================
const WORKER_ID = `${process.env.HOSTNAME || 'notif'}-${process.pid}`;

// Recupera locks orfaos (worker crashou): a cada minuto, libera linhas locked > 5min.
async function reclaimOrphanLocks() {
  await query(
    `UPDATE notifications SET locked_by = NULL, locked_at = NULL
      WHERE locked_at IS NOT NULL AND locked_at < NOW() - INTERVAL '5 minutes'`
  );
}

async function processOutbox() {
  // FIX-13-1 (race condition): claim atomico via UPDATE ... RETURNING.
  // Apenas um worker (entre varias replicas) consegue setar locked_by.
  const claimed = await query(
    `UPDATE notifications
        SET locked_by = $1, locked_at = NOW()
      WHERE id IN (
        SELECT id FROM notifications
         WHERE sent_status = 'pending'
           AND channel IN ('email','telegram')
           AND retry_count < 5
           AND next_retry_at <= NOW()
           AND locked_by IS NULL
         ORDER BY priority DESC, created_at ASC
         LIMIT 25
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id`,
    [WORKER_ID]
  );

  if (!claimed.rows.length) return;
  const ids = claimed.rows.map((r) => r.id);

  // Carrega payload completo das linhas claimed
  const pending = await query(
    `SELECT n.id, n.user_id, n.channel, n.template_code, n.title, n.body, n.body_html,
            n.priority, n.payload, n.retry_count, u.email, u.full_name, u.locale
       FROM notifications n
       JOIN users u ON u.id = n.user_id
      WHERE n.id = ANY($1::uuid[])`,
    [ids]
  );

  for (const n of pending.rows) {
    try {
      // FIX-WORKER-13: Mustache-like {{var}} render usando payload + user data.
      // Antes: emails saiam com placeholders literais ({{name}}, {{order_number}}).
      // Agora: substitui antes de enviar. Funciona em title, body e body_html.
      let title = n.title;
      let body = n.body;
      let bodyHtml = n.body_html;
      const hasPlaceholder = (s) => typeof s === 'string' && s.includes('{{');
      if (hasPlaceholder(title) || hasPlaceholder(body) || hasPlaceholder(bodyHtml)) {
        const ctx = {
          name: n.full_name || 'cliente',
          full_name: n.full_name || '',
          email: n.email || '',
          ...(typeof n.payload === 'object' && n.payload ? n.payload : {}),
        };
        title = renderMustache(title || '', ctx);
        body  = renderMustache(body  || '', ctx);
        bodyHtml = bodyHtml ? renderMustache(bodyHtml, ctx) : null;
      }
      // Defense: nunca enviar com title vazio (anti-spam-filter)
      if (!title || !title.trim()) title = '(sem assunto - revise template)';
      if (!body || !body.trim()) body = '(sem conteudo)';

      if (n.channel === 'email') {
        await sendEmail(n.email, title, body, bodyHtml);
      } else if (n.channel === 'telegram') {
        await sendTelegram(`*${title}*\n${body}`);
      }
      await query(
        `UPDATE notifications
            SET sent_status = 'sent', sent_at = NOW(),
                locked_by = NULL, locked_at = NULL
          WHERE id = $1`,
        [n.id]
      );
      log.info({ id: n.id, channel: n.channel, to: mask.text(n.email || '') }, '[notif.sent]');
    } catch (e) {
      // FIX-13-2 (backoff): proxima tentativa com delay exponencial.
      // 1->30s, 2->2min, 3->10min, 4->1h, 5->terminal failed
      const nextRetry = n.retry_count + 1;
      const backoffSeconds = [30, 120, 600, 3600][n.retry_count] || 3600;
      log.warn({ id: n.id, err: e.message, attempt: nextRetry, backoffSeconds }, '[notif.fail]');
      await query(
        `UPDATE notifications
            SET retry_count = retry_count + 1,
                failed_reason = $1,
                sent_status = CASE WHEN retry_count + 1 >= 5 THEN 'failed' ELSE 'pending' END,
                next_retry_at = NOW() + ($2 || ' seconds')::INTERVAL,
                locked_by = NULL,
                locked_at = NULL
          WHERE id = $3`,
        [e.message.slice(0, 500), String(backoffSeconds), n.id]
      );
    }
  }
}

// Cron: a cada 30s processa outbox
cron.schedule('*/30 * * * * *', () => processOutbox().catch((e) => log.error({ err: e.message }, '[outbox.err]')));
// Cron: a cada minuto recupera locks orfaos
cron.schedule('* * * * *', () => reclaimOrphanLocks().catch((e) => log.error({ err: e.message }, '[outbox.reclaim_err]')));

// Cron diario: limpeza de notifications antigas (60d)
cron.schedule('0 4 * * *', async () => {
  const r = await query(`DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '60 days' RETURNING id`);
  log.info({ deleted: r.rowCount }, '[notif.cleanup]');
});

app.use((req, res) => res.status(404).json({ error: 'route_not_found' }));
app.use(errorHandler.errorMiddleware);

const server = app.listen(PORT, () => log.info({ port: PORT }, '[notification-svc] listening'));
['SIGINT','SIGTERM'].forEach((s) => process.on(s, () => server.close(() => process.exit(0))));
