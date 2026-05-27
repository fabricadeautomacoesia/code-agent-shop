'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger, cache } = require('@cas/shared');

const router = express.Router();
const log = logger.child({ svc: 'seller-svc', mod: 'admin' });
router.use(jwt.requireAuth({ roles: ['admin','staff'] }));

// FIX-WORKER-18 pass 6: helper invalidate cache apos admin mutations
async function invalidateSellerCache(sellerId) {
  try {
    const r = await query('SELECT store_slug FROM sellers WHERE id = $1', [sellerId]);
    const tasks = [cache.del('sellers:list:*')];
    if (r.rows.length) {
      const slug = r.rows[0].store_slug;
      tasks.push(
        cache.del(`sellers:detail:${slug}`),
        cache.del(`sellers:stats:${slug}`),
        cache.del(`sellers:products:${slug}:*`)
      );
    }
    await Promise.all(tasks);
  } catch (e) { log.warn({ err: e.message }, '[cache.invalidate_fail]'); }
}

// POST /sellers/admin/:id/promote-class-b - admin promove seller a Classe B
router.post('/:id/promote-class-b',
  validate({ body: z.object({ sla_days: z.number().int().min(1).max(365).default(15) }) }),
  asyncHandler(async (req, res) => {
    const r = await query(
      `UPDATE sellers SET seller_class = 'class_b', sla_active = TRUE, sla_days = $1,
         sla_last_upload_at = NOW(),
         sla_next_deadline_at = NOW() + ($1 || ' days')::INTERVAL,
         updated_at = NOW()
       WHERE id = $2 RETURNING id, seller_class, sla_next_deadline_at`,
      [req.body.sla_days, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
    log.warn({ actor: req.user.sub, target: req.params.id }, '[seller.promote_b]');
    await invalidateSellerCache(req.params.id);
    res.json({ seller: r.rows[0] });
  })
);

// POST /sellers/admin/:id/suspend (Kill Switch)
router.post('/:id/suspend',
  validate({ body: z.object({ reason: z.string().min(5).max(500) }) }),
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE sellers SET status = 'suspended', updated_at = NOW()
       WHERE id = $1`, [req.params.id]
    );
    // revoga sessoes do usuario
    await query(
      `UPDATE user_sessions SET is_revoked = TRUE, revoked_reason = 'seller_suspended', revoked_at = NOW()
       WHERE user_id = (SELECT user_id FROM sellers WHERE id = $1)`,
      [req.params.id]
    );
    // audit
    await query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1,$2,'seller.suspend','seller',$3,'warn', $4::JSONB)`,
      [req.user.sub, req.user.role, req.params.id, JSON.stringify({ reason: req.body.reason })]
    );
    log.warn({ actor: req.user.sub, target: req.params.id, reason: req.body.reason }, '[seller.suspend]');
    // FIX-WORKER-18 pass 6: invalida cache (suspend muda status -> some da listagem publica)
    await invalidateSellerCache(req.params.id);
    res.json({ ok: true });
  })
);

// POST /sellers/admin/:id/reactivate
router.post('/:id/reactivate', asyncHandler(async (req, res) => {
  await query(
    `UPDATE sellers SET status = 'active', updated_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  // FIX-WORKER-18 pass 6: invalida cache (reactivate volta a aparecer na listagem)
  await invalidateSellerCache(req.params.id);
  res.json({ ok: true });
}));

// FIX-WORKER-4: GET /sellers/admin/sla-risk - sellers Classe B proximos do deadline SLA.
// Critical para admin agir antes da revogacao automatica de API keys.
// Threshold default: 3 dias (configuravel via query param ?days=N).
router.get('/sla-risk', asyncHandler(async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '3', 10), 30);
  const r = await query(
    `SELECT s.id, s.store_name, s.store_slug, s.seller_class, s.sla_active,
            s.sla_days, s.sla_last_upload_at, s.sla_next_deadline_at,
            s.sla_revoked_count, s.status,
            EXTRACT(EPOCH FROM (s.sla_next_deadline_at - NOW()))/86400 AS days_remaining,
            u.email, u.full_name
       FROM sellers s
       JOIN users u ON u.id = s.user_id
      WHERE s.seller_class = 'class_b'
        AND s.sla_active = TRUE
        AND s.sla_next_deadline_at IS NOT NULL
        AND s.sla_next_deadline_at <= NOW() + ($1 || ' days')::INTERVAL
        AND s.status NOT IN ('suspended','banned')
      ORDER BY s.sla_next_deadline_at ASC LIMIT 100`,
    [String(days)]
  );
  res.json({ at_risk: r.rows, count: r.rows.length, threshold_days: days });
}));

// FIX-WORKER-4: GET /sellers/admin/all - listing geral com filtros + paginacao.
// Suporta ?status=active|pending_kyc|suspended|banned, ?seller_class=class_a|class_b,
// ?q=search_term (matches store_name ou email), ?limit, ?page.
router.get('/all', asyncHandler(async (req, res) => {
  // FIX-WORKER-7 pass 4: Math.max(1, ...) clamp p/ rejeitar negativos
  const lim = Math.max(1, Math.min(parseInt(req.query.limit || '30', 10), 100));
  const off = (Math.max(parseInt(req.query.page || '1', 10), 1) - 1) * lim;
  const where = ['1=1'];
  const params = [];
  let i = 1;
  if (req.query.status) {
    where.push(`s.status = $${i++}`); params.push(req.query.status);
  }
  if (req.query.seller_class) {
    where.push(`s.seller_class = $${i++}`); params.push(req.query.seller_class);
  }
  if (req.query.q) {
    where.push(`(s.store_name ILIKE $${i} OR u.email ILIKE $${i})`);
    params.push(`%${req.query.q}%`); i++;
  }
  params.push(lim, off);
  const r = await query(
    `SELECT s.id, s.store_slug, s.store_name, s.seller_class, s.status,
            s.reputation_tier, s.reputation_score, s.total_sales, s.total_products_active,
            s.created_at, u.email, u.full_name
       FROM sellers s JOIN users u ON u.id = s.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.created_at DESC
      LIMIT $${i} OFFSET $${i+1}`,
    params
  );
  const cnt = await query(
    `SELECT COUNT(*) AS total FROM sellers s JOIN users u ON u.id = s.user_id WHERE ${where.join(' AND ')}`,
    params.slice(0, -2)
  );
  res.json({ sellers: r.rows, total: parseInt(cnt.rows[0].total, 10), page: parseInt(req.query.page || '1', 10), limit: lim });
}));

// GET /sellers/admin/pending-kyc
// FIX-WORKER-7 pass 42: 3 BUGS corrigidos:
// 1. Pre-fix filtrava SO status='pending_kyc' - apos mig 045, novo status
//    'kyc_submitted' eh o real "aguardando review". Endpoint ficaria vazio
//    pos-deploy mig 045.
// 2. Regra I SELECT s.* vaza campos internos (document_number_hash, kyc_*).
// 3. ORDER BY created_at ASC sem tiebreaker.
router.get('/pending-kyc', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT s.id, s.store_slug, s.store_name, s.status, s.seller_class,
            s.document_type, s.legal_name,
            s.address_city, s.address_state, s.address_zip,
            s.kyc_submitted_at, s.kyc_reviewed_at, s.kyc_rejection_reason,
            s.created_at,
            u.email, u.full_name
       FROM sellers s
       JOIN users u ON u.id = s.user_id
      WHERE s.status IN ('pending_kyc','kyc_submitted')
      ORDER BY
        CASE s.status
          WHEN 'kyc_submitted' THEN 1   -- priorizar review (FIFO submit time)
          WHEN 'pending_kyc' THEN 2
          ELSE 3
        END,
        s.kyc_submitted_at ASC NULLS LAST,
        s.created_at ASC,
        s.id
      LIMIT 100`
  );
  res.json({ sellers: r.rows });
}));

// FIX-WORKER-7 pass 42: NOVO endpoint POST /sellers/admin/:id/kyc/approve
// Aplicando pattern admin-terminal consolidado (pass 25/31/36/37/39).
//
// Layer 2 do compliance flow (pass 41 Layer 1 + pass 40 Layer 3):
// - seller submit /kyc -> status='kyc_submitted' (pass 41)
// - admin approve -> status='active' (esta iter)
// - admin reject -> status='kyc_rejected' + reason (esta iter)
// - pass 40 /payout SO aceita status='active' (combo defense complete)
const KYC_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { tx } = require('@cas/db-client');

router.post('/:id/kyc/approve',
  asyncHandler(async (req, res, next) => {
    if (!KYC_UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }

    let outcome;
    await tx(async (c) => {
      // Regra K FOR UPDATE + Regra Q idempotent terminal
      const cur = await c.query(
        `SELECT id, status, document_type, legal_name FROM sellers
          WHERE id = $1::UUID FOR UPDATE`,
        [req.params.id]
      );
      if (!cur.rows.length) { outcome = { error: 'not_found' }; return; }
      const s = cur.rows[0];

      // Regra Q: SO kyc_submitted pode ser approved
      // active = ja approved (idempotent), pending_kyc = nunca submeteu, suspended = bloqueado
      if (s.status !== 'kyc_submitted') {
        outcome = { error: 'invalid_state', current_status: s.status };
        return;
      }

      // UPDATE com idempotent guard
      await c.query(
        `UPDATE sellers SET
            status = 'active',
            kyc_reviewed_at = NOW(),
            kyc_reviewed_by_user_id = $1::UUID,
            kyc_rejection_reason = NULL,
            updated_at = NOW()
          WHERE id = $2::UUID AND status = 'kyc_submitted'`,
        [req.user.sub, req.params.id]
      );

      // Audit log atomic (pattern pass 23/25/31 - sec event compliance critical)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'kyc.approve', 'seller', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({
           document_type: s.document_type,
           legal_name_length: s.legal_name?.length || 0,
           ip: req.ip,
         })]
      );

      // Notification ao seller (UX engagement - aprovado!)
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body)
         SELECT user_id, 'email', 'kyc_approved',
                'KYC aprovado!',
                'Seu KYC foi aprovado. Voce ja pode publicar produtos e solicitar saques.'
           FROM sellers WHERE id = $1::UUID`,
        [req.params.id]
      );
    });

    if (outcome?.error === 'not_found') return next(errorHandler.notFound('seller_not_found'));
    if (outcome?.error === 'invalid_state') {
      return res.status(409).json({
        error: 'invalid_state',
        message: `Estado atual '${outcome.current_status}' nao permite aprovacao. Apenas kyc_submitted.`,
        current_status: outcome.current_status,
      });
    }
    await invalidateSellerCache(req.params.id);
    log.warn({ actor: req.user.sub, target: req.params.id }, '[kyc.approve]');
    res.json({ ok: true, new_status: 'active' });
  })
);

// POST /sellers/admin/:id/kyc/reject
router.post('/:id/kyc/reject',
  validate({ body: z.object({ reason: z.string().min(10).max(2000) }) }),
  asyncHandler(async (req, res, next) => {
    if (!KYC_UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }

    let outcome;
    await tx(async (c) => {
      const cur = await c.query(
        `SELECT id, status, document_type FROM sellers
          WHERE id = $1::UUID FOR UPDATE`,
        [req.params.id]
      );
      if (!cur.rows.length) { outcome = { error: 'not_found' }; return; }
      const s = cur.rows[0];

      if (s.status !== 'kyc_submitted') {
        outcome = { error: 'invalid_state', current_status: s.status };
        return;
      }

      // FIX-WORKER-7 pass 42: REJECT preserva document_number_hash p/ unique
      // constraint funcionar (anti re-submit same doc), MAS limpa para permitir
      // seller RE-SUBMETER novo documento. Trade-off: hash mantido = anti-fraud,
      // mas seller corrige rejection_reason e re-submete (status -> kyc_submitted).
      await c.query(
        `UPDATE sellers SET
            status = 'kyc_rejected',
            kyc_reviewed_at = NOW(),
            kyc_reviewed_by_user_id = $1::UUID,
            kyc_rejection_reason = $2,
            updated_at = NOW()
          WHERE id = $3::UUID AND status = 'kyc_submitted'`,
        [req.user.sub, req.body.reason, req.params.id]
      );

      // Audit log atomic
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'kyc.reject', 'seller', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({ reason: req.body.reason, document_type: s.document_type, ip: req.ip })]
      );

      // Notification ao seller (UX - sabe motivo + corrigir)
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body)
         SELECT user_id, 'email', 'kyc_rejected',
                'KYC nao aprovado',
                $2
           FROM sellers WHERE id = $1::UUID`,
        [req.params.id, `Motivo: ${req.body.reason}. Voce pode re-submeter o KYC com correcoes.`]
      );
    });

    if (outcome?.error === 'not_found') return next(errorHandler.notFound('seller_not_found'));
    if (outcome?.error === 'invalid_state') {
      return res.status(409).json({
        error: 'invalid_state',
        message: `Estado atual '${outcome.current_status}' nao permite rejeicao. Apenas kyc_submitted.`,
        current_status: outcome.current_status,
      });
    }
    await invalidateSellerCache(req.params.id);
    log.warn({ actor: req.user.sub, target: req.params.id, reason: req.body.reason.slice(0, 50) }, '[kyc.reject]');
    res.json({ ok: true, new_status: 'kyc_rejected' });
  })
);

// GET /sellers/admin/payouts/pending
// FIX-WORKER-4 pass 4: bug "Transferir Asaas" feature MORTA.
// Endpoint /pending so retornava status='pending'. Apos admin clicar "Aprovar",
// status vira 'approved' -> SUMME da lista. UI tinha codigo (linha 98-103
// dashboard-admin/payouts/page.tsx) para mostrar botao "Transferir Asaas" quando
// p.status === 'approved', mas esses payouts nunca chegavam ao frontend.
// Feature inteira invisivel ao admin -> transfers Asaas dependiam de cron/manual.
// FIX: aceitar ?status=pending|approved|all (default backward-compat = pending).
// Quando ?status=approved ou all, UI ve approved payouts e pode disparar /process.
router.get('/payouts/pending', asyncHandler(async (req, res) => {
  const statusParam = (req.query.status || 'pending').toString().toLowerCase();
  const VALID = new Set(['pending','approved','all']);
  const status = VALID.has(statusParam) ? statusParam : 'pending';
  const where = status === 'all'
    ? `p.status IN ('pending','approved')`
    : `p.status = '${status}'`;
  const r = await query(
    `SELECT p.*, s.store_name FROM seller_payouts p
       JOIN sellers s ON s.id = p.seller_id
      WHERE ${where} ORDER BY p.requested_at ASC LIMIT 100`
  );
  res.json({ payouts: r.rows, filter: { status } });
}));

// FIX-WORKER-4: regex UUID antes de bater no DB
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /sellers/admin/payouts/:id/approve
// FIX-WORKER-4: antes silenciava ok:true mesmo com UPDATE 0 rows (UUID inexistente ou nao-pending).
// Admin clicava aprovar -> mensagem de sucesso falsa, mas nada havia acontecido.
// Agora: 400 invalid_uuid / 404 payout_not_pending com RETURNING id.
router.post('/payouts/:id/approve', asyncHandler(async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) {
    return next(errorHandler.badRequest('invalid_uuid'));
  }
  const r = await query(
    `UPDATE seller_payouts SET status = 'approved', approved_at = NOW(), approved_by = $1
      WHERE id = $2 AND status = 'pending' RETURNING id`,
    [req.user.sub, req.params.id]
  );
  if (!r.rows.length) return next(errorHandler.notFound('payout_not_pending'));
  // payment-svc disparara Asaas transfer
  res.json({ ok: true, approved: r.rows[0].id });
}));

// POST /sellers/admin/payouts/:id/reject
// FIX-WORKER-4: mesma logica de RETURNING + UUID guard
router.post('/payouts/:id/reject',
  validate({ body: z.object({ reason: z.string().min(3) }) }),
  asyncHandler(async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }
    const r = await query(
      `UPDATE seller_payouts SET status = 'rejected', rejected_reason = $1
       WHERE id = $2 AND status = 'pending' RETURNING id`,
      [req.body.reason, req.params.id]
    );
    if (!r.rows.length) return next(errorHandler.notFound('payout_not_pending'));
    res.json({ ok: true, rejected: r.rows[0].id });
  })
);

module.exports = router;
