'use strict';

const cron = require('node-cron');
const { query, tx } = require('@cas/db-client');
const { logger, mask, notifCache } = require('@cas/shared');

const log = logger.child({ svc: 'seller-svc', mod: 'sla-checker' });

/**
 * SLA Cron Classe B (V8 spec):
 *   - hourly: verifica deadlines, envia warnings (7d, 3d, 1d), revoga ao vencer.
 *   - Quando vence: status = sla_revoked + revoga TODAS as vault_api_keys do seller.
 */
async function checkSlaDeadlines() {
  log.info('[sla-checker] start');

  // 1. WARNINGS (7d, 3d, 1d)
  const warningDays = (process.env.SLA_WARNING_DAYS || '7,3,1').split(',').map(Number);
  for (const days of warningDays) {
    const r = await query(
      `SELECT s.id, s.user_id, s.store_name, s.sla_next_deadline_at,
              u.email, u.full_name
         FROM sellers s
         JOIN users u ON u.id = s.user_id
        WHERE s.seller_class = 'class_b'
          AND s.sla_active = TRUE
          AND s.status = 'active'
          AND s.sla_next_deadline_at BETWEEN NOW() + ($1 || ' days')::INTERVAL - INTERVAL '1 hour'
                                          AND NOW() + ($1 || ' days')::INTERVAL + INTERVAL '1 hour'`,
      [days]
    );
    /* FIX-WORKER-5 pass 476 (notifCache cross-svc - SLA warnings cron):
       PRE-FIX: SLA warning notif cron sem invalidate cache.
       - Seller proximo de SLA deadline = priority warning (cash flow risk)
       - Seller refresh dashboard /financeiro -> stale ate 20s
       - SLA warnings (7d/3d/1d) sao engagement-critical
       POST-FIX: capture warnedUserIds[] + invalidateBulk apos loop. */
    const warnedUserIds = [];
    for (const seller of r.rows) {
      await query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, payload)
         VALUES ($1, 'email', $2, $3, $4, $5::JSONB)`,
        [
          seller.user_id,
          `sla_warning_${days}d`,
          `SLA: ${days} dias restantes`,
          `Voce tem ${days} dias para enviar um produto aprovado. Caso contrario, suas API keys serao revogadas.`,
          JSON.stringify({ name: seller.full_name, days, deadline: seller.sla_next_deadline_at })
        ]
      );
      await query(
        `INSERT INTO seller_sla_history (seller_id, event, deadline_was, notes)
         VALUES ($1, 'warning_sent', $2, $3)`,
        [seller.id, seller.sla_next_deadline_at, `warning ${days}d`]
      );
      warnedUserIds.push(seller.user_id);
    }
    if (warnedUserIds.length) notifCache.invalidateBulk(warnedUserIds);
    log.info({ days, sellers_warned: r.rows.length }, '[sla.warning]');
  }

  // 2. REVOGAR vencidos
  const expired = await query(
    `SELECT s.id, s.user_id, s.store_name
       FROM sellers s
      WHERE s.seller_class = 'class_b'
        AND s.sla_active = TRUE
        AND s.status = 'active'
        AND s.sla_next_deadline_at < NOW()`
  );

  for (const seller of expired.rows) {
    await tx(async (c) => {
      await c.query(
        `UPDATE sellers
            SET status = 'sla_revoked',
                sla_revoked_count = sla_revoked_count + 1,
                updated_at = NOW()
          WHERE id = $1`, [seller.id]
      );
      // Revoga vault keys do seller
      await c.query(
        `UPDATE vault_api_keys
            SET is_active = FALSE, revoked_at = NOW(), revoked_reason = 'sla_revoked'
          WHERE seller_id = $1 AND is_active = TRUE`, [seller.id]
      );
      // Revoga sessoes ativas (forca logout)
      await c.query(
        `UPDATE user_sessions
            SET is_revoked = TRUE, revoked_at = NOW(), revoked_reason = 'sla_revoked'
          WHERE user_id = $1 AND is_revoked = FALSE`, [seller.user_id]
      );
      // History + notification
      await c.query(
        `INSERT INTO seller_sla_history (seller_id, event, notes)
         VALUES ($1, 'revoked', 'SLA Classe B vencido. Keys e sessoes revogadas.')`,
        [seller.id]
      );
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, priority)
         VALUES ($1,'email','sla_revoked','Acesso suspenso',
                 'Seu SLA Classe B venceu. As API keys foram revogadas. Contate suporte.', 2)`,
        [seller.user_id]
      );
      // Alert para admin
      await c.query(
        `INSERT INTO alerts (severity, source, code, title, message, target_type, target_id)
         VALUES ('warn','sla-checker','sla_revoked',$1,$2,'seller',$3)`,
        [`Seller SLA revogado: ${seller.store_name}`,
         `Seller id=${seller.id} teve SLA Classe B revogado automaticamente.`,
         seller.id]
      );
    });
    /* FIX-WORKER-5 pass 476 (notifCache - sla_revoked priority 2 critical):
       SLA revogado = seller perde acesso vault + sessoes. Notif imediata = essencial
       p/ seller saber 'por que nao acesso?' antes do refresh manual. */
    notifCache.invalidate(seller.user_id);
    log.warn({ seller_id: seller.id, store: seller.store_name }, '[sla.revoked]');
  }

  log.info({ warned: warningDays.length, revoked: expired.rows.length }, '[sla-checker] done');
}

function start() {
  // hourly
  cron.schedule('7 * * * *', () => checkSlaDeadlines().catch((e) => log.error({ /* FIX pass 343 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[sla.cron_error]')));
  log.info('[sla-checker] cron hourly scheduled');
}

module.exports = { start, checkSlaDeadlines };
