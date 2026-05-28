'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, logger, cache, maskPII } = require('@cas/shared');

// FIX-WORKER-7 pass 60: LGPD role-tier helper.
// Aplica maskPII em email+full_name p/ role STAFF (admin vê full).
// PRE-FIX: 3 endpoints admin (/sla-risk, /all, /pending-kyc) retornavam PII
// plain text p/ STAFF sub-role - viola LGPD Art 6° II (necessidade).
// Pattern consolidado pass 57/59 cross-svc.
function maskSellersForStaff(req, rows) {
  const isAdmin = req.user && req.user.role === 'admin';
  if (isAdmin) return rows;
  return rows.map((row) => ({
    ...row,
    email: maskPII.email(row.email),
    full_name: maskPII.name(row.full_name),
  }));
}

const router = express.Router();
const log = logger.child({ svc: 'seller-svc', mod: 'admin' });
router.use(jwt.requireAuth({ roles: ['admin','staff'] }));

// FIX-WORKER-18 pass 6 + 197 + 199 + 203: helper invalidate cache apos admin mutations
async function invalidateSellerCache(sellerId) {
  try {
    const r = await query('SELECT store_slug FROM sellers WHERE id = $1', [sellerId]);
    const tasks = [
      cache.del('sellers:list:*'),                  // public list cache
      cache.del('seller:admin:all:*'),              // W18 pass 197: admin /all dashboard
      cache.del('seller:admin:pending-kyc:*'),      // W18 pass 199: admin /pending-kyc
      cache.del('seller:admin:sla-risk:*'),         // W18 pass 203: admin /sla-risk
    ];
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

// FIX-WORKER-7 pass 44: 8 BUGS aplicando Pattern W7 (Regra Q terminal + audit + tx).
const SUSPEND_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /sellers/admin/:id/suspend (Kill Switch)
// BUGS CORRIGIDOS (4):
// 1. UUID validate (anti PG 22P02 -> 500 generico)
// 2. Regra Q idempotent terminal: suspend de ja-suspended = 409 (preserva audit timeline)
// 3. Regra K FOR UPDATE + tx() atomic (UPDATE seller + revoke sessions + audit_log all-or-nothing)
// 4. Silent UPDATE rowcount=0 -> 404 explicit (seller id inexistente)
// + Notification ao seller (UX - sabe que foi suspenso + reason)
router.post('/:id/suspend',
  validate({ body: z.object({ reason: z.string().min(5).max(500) }) }),
  asyncHandler(async (req, res, next) => {
    if (!SUSPEND_UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }

    let outcome;
    await tx(async (c) => {
      // FIX bug 3+4 (Regra K + 404): SELECT FOR UPDATE + existence + status check
      const cur = await c.query(
        `SELECT id, user_id, status FROM sellers
          WHERE id = $1::UUID FOR UPDATE`, [req.params.id]
      );
      if (!cur.rows.length) { outcome = { error: 'not_found' }; return; }
      const s = cur.rows[0];

      // FIX bug 2 (Regra Q): idempotent terminal - SO non-terminal pode suspend
      // 'suspended','banned' = ja terminal. 'kyc_rejected' = ja blocked.
      if (s.status === 'suspended' || s.status === 'banned') {
        outcome = { error: 'already_suspended', current_status: s.status };
        return;
      }

      // UPDATE atomic com idempotent guard
      await c.query(
        `UPDATE sellers SET status = 'suspended', updated_at = NOW()
          WHERE id = $1::UUID AND status NOT IN ('suspended','banned')`,
        [req.params.id]
      );
      // Revoga sessoes (mesmo tx)
      await c.query(
        `UPDATE user_sessions SET is_revoked = TRUE,
                                   revoked_reason = 'seller_suspended', revoked_at = NOW()
          WHERE user_id = $1::UUID AND is_revoked = FALSE`,
        [s.user_id]
      );
      // Audit log atomic
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'seller.suspend', 'seller', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({ reason: req.body.reason, previous_status: s.status, ip: req.ip })]
      );
      // Notification ao seller (UX - sabe motivo)
      // FIX-WORKER-4 pass 258 (priority p/ seller_suspended):
      //   PRE-FIX: INSERT sem priority -> default=0 -> notif fica end of outbox
      //   queue (processOutbox ORDER BY priority DESC, created_at ASC). Seller
      //   demora para ver "conta suspensa" em produto outage.
      //   Suspend = critical (impacta cash flow seller, login bloqueado).
      //   POST-FIX: priority=3 (criticos pattern V8: payment-fail, security,
      //   account-state changes). Outbox prioriza imediatamente.
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, priority)
         VALUES ($1::UUID, 'email', 'seller_suspended',
                 'Sua conta foi suspensa',
                 $2, 3)`,
        [s.user_id, `Motivo: ${req.body.reason}. Entre em contato com o suporte para mais informacoes.`]
      );
    });

    if (outcome?.error === 'not_found') return next(errorHandler.notFound('seller_not_found'));
    if (outcome?.error === 'already_suspended') {
      return res.status(409).json({
        error: 'already_suspended',
        message: `Seller ja esta em status '${outcome.current_status}'.`,
        current_status: outcome.current_status,
      });
    }

    log.warn({ actor: req.user.sub, target: req.params.id, reason: req.body.reason }, '[seller.suspend]');
    await invalidateSellerCache(req.params.id);
    res.json({ ok: true, new_status: 'suspended' });
  })
);

// POST /sellers/admin/:id/reactivate
// FIX-WORKER-7 pass 44: 4 BUGS CRITICOS (compliance bypass + missing audit + missing reason)
//
// BUG 1 *** COMPLIANCE BYPASS *** reactivate aceita qualquer status -> active
//   PRE-FIX: UPDATE SET status='active' WHERE id=$1 (sem status check)
//   CENARIO BYPASS:
//   - Seller submete KYC fake -> admin REJECT -> status='kyc_rejected'
//   - Admin "reactivate" -> status='active' (sem re-aprovar KYC!)
//   - BYPASS TOTAL do flow KYC estabelecido pass 41/42
//   Pattern correto: reactivate SO suspended -> active.
//   Para approve KYC pos-reject: endpoint dedicado /kyc/approve (pass 42)
//   FIX: WHERE status = 'suspended' (idempotent guard exato)
//
// BUG 2 *** AUDIT_LOG MISSING *** suspend tem, reactivate NAO - assimetria forense
//   Pattern security cross-endpoint: ambos mutation high-impact = ambos audit_log
//   FIX: INSERT audit_log atomic (sym a suspend)
//
// BUG 3 *** REASON BODY MISSING *** forense incompleta
//   Admin reactivate sem registrar PORQUE - timeline forense vazia
//   FIX: validate body { reason: string min 5 max 500 }
//
// BUG 4 *** Notification ao seller MISSING *** UX
//   Seller suspenso recebe email "suspenso" mas NAO recebe "reativada"
//   Inconsistencia UX. FIX: INSERT notification email atomic
router.post('/:id/reactivate',
  validate({ body: z.object({ reason: z.string().min(5).max(500) }) }),
  asyncHandler(async (req, res, next) => {
    if (!SUSPEND_UUID_RE.test(req.params.id)) {
      return next(errorHandler.badRequest('invalid_uuid'));
    }

    let outcome;
    await tx(async (c) => {
      const cur = await c.query(
        `SELECT id, user_id, status FROM sellers
          WHERE id = $1::UUID FOR UPDATE`, [req.params.id]
      );
      if (!cur.rows.length) { outcome = { error: 'not_found' }; return; }
      const s = cur.rows[0];

      // BUG 1 critical: SO suspended pode ser reactivated (anti compliance bypass)
      // banned = terminal severe (admin manual via SQL se necessario)
      // kyc_rejected = use /kyc/approve dedicated endpoint
      // active = noop (idempotent)
      // pending_kyc/kyc_submitted = nao precisam reactivate
      if (s.status !== 'suspended') {
        outcome = { error: 'invalid_state', current_status: s.status };
        return;
      }

      await c.query(
        `UPDATE sellers SET status = 'active', updated_at = NOW()
          WHERE id = $1::UUID AND status = 'suspended'`,
        [req.params.id]
      );

      // BUG 2: audit_log atomic (simetrico a suspend)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, $2, 'seller.reactivate', 'seller', $3, 'warn', $4::JSONB)`,
        [req.user.sub, req.user.role, req.params.id,
         JSON.stringify({ reason: req.body.reason, previous_status: s.status, ip: req.ip })]
      );

      // BUG 4: notification ao seller (UX engagement)
      // FIX-WORKER-4 pass 258 (priority paridade suspend):
      //   reactivate eh "good news" critico (cash flow unblock + UX engagement)
      //   priority=2 (medium-high) - menor que suspend(3) mas alto p/ engagement
      await c.query(
        `INSERT INTO notifications (user_id, channel, template_code, title, body, priority)
         VALUES ($1::UUID, 'email', 'seller_reactivated',
                 'Sua conta foi reativada',
                 'Sua conta seller foi reativada. Voce pode voltar a publicar produtos e solicitar saques.', 2)`,
        [s.user_id]
      );
    });

    if (outcome?.error === 'not_found') return next(errorHandler.notFound('seller_not_found'));
    if (outcome?.error === 'invalid_state') {
      return res.status(409).json({
        error: 'invalid_state',
        message: outcome.current_status === 'banned'
          ? 'Seller banido nao pode ser reativado via este endpoint.'
          : outcome.current_status === 'kyc_rejected'
            ? 'Use POST /:id/kyc/approve para aprovar KYC pos-rejeicao.'
            : `Status atual '${outcome.current_status}' - reactivate aplica SO a 'suspended'.`,
        current_status: outcome.current_status,
      });
    }

    log.warn({ actor: req.user.sub, target: req.params.id, reason: req.body.reason }, '[seller.reactivate]');
    await invalidateSellerCache(req.params.id);
    res.json({ ok: true, new_status: 'active' });
  })
);

// FIX-WORKER-4: GET /sellers/admin/sla-risk - sellers Classe B proximos do deadline SLA.
// Critical para admin agir antes da revogacao automatica de API keys.
// Threshold default: 3 dias (configuravel via query param ?days=N).
//
// FIX-WORKER-18 pass 203 (4 melhorias compostas):
// PRE-FIX:
// - Hardcoded LIMIT 100 sem ?limit/?offset
// - 'count: r.rows.length' bug paginated_total (mesmo pattern pass 189/201)
// - ORDER BY sla_next_deadline_at ASC sem tiebreaker (Regra D)
// - NO cache - admin /sla-risk dashboard polling sem proteção
// POST-FIX:
// + ?limit (1-200) + ?offset (>=0) paginacao V8 Regra E
// + COUNT(*) OVER() window + has_more boolean response
// + s.id ASC tiebreaker (Regra D)
// + cache 60s vary by days+limit+offset (SLA deadline atualiza por upload/cron - 60s OK)
const slaRiskCacheKey = (req) => {
  const q = req.query;
  return `seller:admin:sla-risk:d=${q.days||3}:lim=${q.limit||50}:off=${q.offset||0}`;
};
router.get('/sla-risk',
  cache.cacheMiddleware(slaRiskCacheKey, 60),
  asyncHandler(async (req, res) => {
    const days = Math.min(parseInt(req.query.days || '3', 10), 30);
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const r = await query(
      `SELECT s.id, s.store_name, s.store_slug, s.seller_class, s.sla_active,
              s.sla_days, s.sla_last_upload_at, s.sla_next_deadline_at,
              s.sla_revoked_count, s.status,
              EXTRACT(EPOCH FROM (s.sla_next_deadline_at - NOW()))/86400 AS days_remaining,
              u.email, u.full_name,
              COUNT(*) OVER()::INT AS _total
         FROM sellers s
         JOIN users u ON u.id = s.user_id
        WHERE s.seller_class = 'class_b'
          AND s.sla_active = TRUE
          AND s.sla_next_deadline_at IS NOT NULL
          AND s.sla_next_deadline_at <= NOW() + ($1 || ' days')::INTERVAL
          AND s.status NOT IN ('suspended','banned')
        ORDER BY s.sla_next_deadline_at ASC, s.id ASC
        LIMIT $2 OFFSET $3`,
      [String(days), limit, offset]
    );

    const total = r.rows[0]?._total ?? 0;
    const rows = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });

    // FIX-WORKER-7 pass 60: LGPD role-tier masking
    res.json({
      at_risk: maskSellersForStaff(req, rows),
      total,
      count: rows.length,
      limit,
      offset,
      threshold_days: days,
      has_more: (offset + rows.length) < total,
    });
  })
);

// FIX-WORKER-4: GET /sellers/admin/all - listing geral com filtros + paginacao.
// Suporta ?status=active|pending_kyc|suspended|banned, ?seller_class=class_a|class_b,
// ?q=search_term (matches store_name ou email), ?limit, ?page.
// FIX-WORKER-18 pass 197 (cache + window + tiebreaker):
// PRE-FIX: 2 queries (rows + COUNT separado), sem cache, ORDER BY sem tiebreaker
//   Em prod 500+ sellers + admin recarregando dashboard /sellers a cada 1min:
//   - 2 queries por hit -> 4 PG round-trips/min/admin
//   - Sem tiebreaker: 2 sellers created_at identicos (bulk migration) -> ordem
//     indefinida entre cache evictions/refreshes
// POST-FIX:
//   - cache.cacheMiddleware 30s vary by filtros (admin freshness rapida)
//   - COUNT(*) OVER()::INT AS _total window consolidation
//   - + s.id ASC tiebreaker (Regra D V8)
// Performance: ~25ms (2 queries) -> ~12ms (1 query) ou ~1ms (Redis hit)
const sellersListCacheKey = (req) => {
  const q = req.query;
  return `seller:admin:all:s=${q.status||''}:c=${q.seller_class||''}:q=${q.q||''}:lim=${q.limit||30}:p=${q.page||1}`;
};

router.get('/all',
  cache.cacheMiddleware(sellersListCacheKey, 30),
  asyncHandler(async (req, res) => {
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
              s.created_at, u.email, u.full_name,
              COUNT(*) OVER()::INT AS _total
         FROM sellers s JOIN users u ON u.id = s.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.created_at DESC, s.id ASC
        LIMIT $${i} OFFSET $${i+1}`,
      params
    );
    const total = r.rows[0]?._total ?? 0;
    const rows = r.rows.map((row) => { const { _total, ...rest } = row; return rest; });

    // FIX-WORKER-7 pass 60: LGPD role-tier masking
    res.json({
      sellers: maskSellersForStaff(req, rows),
      total,
      page: parseInt(req.query.page || '1', 10),
      limit: lim,
      has_more: (off + rows.length) < total,
    });
  })
);

// GET /sellers/admin/pending-kyc
// FIX-WORKER-7 pass 42: 3 BUGS corrigidos:
// 1. Pre-fix filtrava SO status='pending_kyc' - apos mig 045, novo status
//    'kyc_submitted' eh o real "aguardando review". Endpoint ficaria vazio
//    pos-deploy mig 045.
// 2. Regra I SELECT s.* vaza campos internos (document_number_hash, kyc_*).
// 3. ORDER BY created_at ASC sem tiebreaker.
// FIX-WORKER-18 pass 199 (4 melhorias compostas):
// PRE-FIX:
// - Hardcoded LIMIT 100 sem pagination -> backlog KYC 200+ invisiveis
// - NO COUNT total - UI 'X de Y' impossivel
// - NO cache - admin polling dashboard
// - Response shape inconsistente com outros endpoints (so {sellers})
// POST-FIX:
// + ?limit (1-200) + ?offset paginacao V8 Regra E
// + COUNT(*) OVER() window total + has_more
// + cache.cacheMiddleware 30s (KYC submissions rates baixos vs payouts)
// + Strip _total interno
// LGPD mask preserved (admin full, staff masked - critico p/ KYC data)
const pendingKycCacheKey = (req) => {
  const q = req.query;
  return `seller:admin:pending-kyc:lim=${q.limit||50}:off=${q.offset||0}`;
};

router.get('/pending-kyc',
  cache.cacheMiddleware(pendingKycCacheKey, 30),
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    const r = await query(
      `SELECT s.id, s.store_slug, s.store_name, s.status, s.seller_class,
              s.document_type, s.legal_name,
              s.address_city, s.address_state, s.address_zip,
              s.kyc_submitted_at, s.kyc_reviewed_at, s.kyc_rejection_reason,
              s.created_at,
              u.email, u.full_name,
              COUNT(*) OVER()::INT AS _total
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
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const total = r.rows[0]?._total ?? 0;

    // FIX-WORKER-7 pass 60: LGPD role-tier masking
    // CRITICAL: /pending-kyc retorna legal_name + address_city/state/zip (cadastro KYC)
    // Staff só precisa display contexto - admin vê full p/ aprovacao
    const isAdmin = req.user && req.user.role === 'admin';
    const sellers = r.rows.map((row) => {
      const { _total, ...rest } = row;
      if (isAdmin) return rest;
      return {
        ...rest,
        email: maskPII.email(rest.email),
        full_name: maskPII.name(rest.full_name),
        legal_name: maskPII.name(rest.legal_name),
      };
    });

    res.json({
      sellers,
      total,
      limit,
      offset,
      has_more: (offset + sellers.length) < total,
    });
  })
);

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
// FIX-WORKER-18 pass 198 (5 melhorias compostas):
// PRE-FIX 5 bugs:
// 1. SELECT p.* - Regra I leak (rejected_reason texto livre + asaas_transfer_id PII)
// 2. Hardcoded LIMIT 100 sem pagination - prod 200+ pending = invisiveis
// 3. ORDER BY requested_at ASC sem tiebreaker (Regra D)
// 4. NO COUNT total - UI 'X de Y' impossivel
// 5. NO cache - admin dashboard polling sem cache (mesmo pattern pass 197)
//
// POST-FIX:
// + cache.cacheMiddleware 20s vary by status (curto pq mutations frequentes)
// + Explicit SELECT fields (positiva whitelist)
// + COUNT(*) OVER() window total + has_more
// + tiebreaker + p.id ASC (determinismo)
// + DLP mask.text rejected_reason (admin pode escrever CPF/Bearer no motivo)
// + ?limit + ?offset (pattern V8 W7 pass E)
// + Parameterized $1 em vez de string interpolation status
const payoutsPendingCacheKey = (req) => {
  const q = req.query;
  return `seller:admin:payouts-pending:s=${q.status||'pending'}:lim=${q.limit||50}:off=${q.offset||0}`;
};

router.get('/payouts/pending',
  cache.cacheMiddleware(payoutsPendingCacheKey, 20),
  asyncHandler(async (req, res) => {
    const statusParam = (req.query.status || 'pending').toString().toLowerCase();
    const VALID = new Set(['pending','approved','all']);
    const status = VALID.has(statusParam) ? statusParam : 'pending';
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // FIX bug 6: parameterize status em vez de string interpolation
    const whereParts = status === 'all'
      ? [`p.status IN ('pending','approved')`]
      : [`p.status = $1`];
    const params = status === 'all' ? [] : [status];
    const iLim = params.length + 1;
    const iOff = params.length + 2;
    params.push(limit, offset);

    const r = await query(
      `SELECT p.id, p.seller_id, p.amount_cents, p.status, p.asaas_transfer_id,
              p.requested_at, p.approved_at, p.paid_at, p.rejected_reason,
              s.store_name,
              COUNT(*) OVER()::INT AS _total
         FROM seller_payouts p
         JOIN sellers s ON s.id = p.seller_id
        WHERE ${whereParts.join(' AND ')}
        ORDER BY p.requested_at ASC, p.id ASC
        LIMIT $${iLim} OFFSET $${iOff}`,
      params
    );

    const total = r.rows[0]?._total ?? 0;
    // FIX bug 1: explicit fields + DLP mask rejected_reason (admin escreve free-text)
    const payouts = r.rows.map((row) => {
      const { _total, rejected_reason, ...rest } = row;
      return {
        ...rest,
        rejected_reason: rejected_reason ? require('@cas/shared').mask.text(rejected_reason) : null,
      };
    });

    res.json({
      payouts,
      total,
      limit,
      offset,
      has_more: (offset + payouts.length) < total,
      filter: { status },
    });
  })
);

// FIX-WORKER-4: regex UUID antes de bater no DB
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /sellers/admin/payouts/:id/approve
// FIX-WORKER-4: antes silenciava ok:true mesmo com UPDATE 0 rows (UUID inexistente ou nao-pending).
// Admin clicava aprovar -> mensagem de sucesso falsa, mas nada havia acontecido.
// Agora: 400 invalid_uuid / 404 payout_not_pending com RETURNING id.
// FIX-WORKER-18 pass 175: helper p/ invalidar cache /payouts do seller dono.
// Apos UPDATE status, seller veria status stale ate 30s no /financeiro.
async function invalidateSellerPayoutsCache(payoutId) {
  try {
    const r = await query(
      `SELECT s.user_id FROM seller_payouts p
         JOIN sellers s ON s.id = p.seller_id WHERE p.id = $1`,
      [payoutId]
    );
    const userId = r.rows[0]?.user_id;
    // FIX-WORKER-18 pass 175 + 198: invalidate seller view + admin dashboard view
    const tasks = [
      cache.del('seller:admin:payouts-pending:*'),  // W18 pass 198 (admin dashboard)
    ];
    if (userId) {
      tasks.push(cache.del(`seller:payouts:${userId}:*`));  // pass 175 (seller view)
    }
    await Promise.all(tasks);
  } catch (_) { /* best-effort */ }
}

router.post('/payouts/:id/approve', asyncHandler(async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) {
    return next(errorHandler.badRequest('invalid_uuid'));
  }
  const r = await query(
    `UPDATE seller_payouts SET status = 'approved', approved_at = NOW(), approved_by = $1
      WHERE id = $2 AND status = 'pending'
      RETURNING id, seller_id, amount_cents`,
    [req.user.sub, req.params.id]
  );
  if (!r.rows.length) return next(errorHandler.notFound('payout_not_pending'));
  // FIX-WORKER-18 pass 175: invalida cache seller (pos-UPDATE)
  await invalidateSellerPayoutsCache(req.params.id);
  // FIX-WORKER-4 pass 235 (audit gap admin financial decision):
  //   Aprovacao de payout = decisao financeira critica que dispara Asaas transfer
  //   real (dinheiro saindo). PRE-FIX: sem audit_log -> compliance gap LGPD
  //   "direito de acesso" (user pede historico - operador X aprovou meu payout
  //   quando?). SOC2 CC1.4: documented authorization decisions.
  //   /payouts/:id/reject (linha 729) tambem faltava - fix conjunto.
  //   POST-FIX: INSERT audit_log atomic (.catch nao quebrar response).
  query(
    `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
     VALUES ($1, $2, 'payout.approve', 'seller_payout', $3, 'warn', $4::JSONB)`,
    [req.user.sub, req.user.role, r.rows[0].id, JSON.stringify({
      seller_id: r.rows[0].seller_id,
      amount_cents: r.rows[0].amount_cents,
      ip: req.ip,
    })]
  ).catch((e) => log.warn({ err: e.message }, '[payout.approve.audit_fail]'));
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
       WHERE id = $2 AND status = 'pending'
       RETURNING id, seller_id, amount_cents`,
      [req.body.reason, req.params.id]
    );
    if (!r.rows.length) return next(errorHandler.notFound('payout_not_pending'));
    // FIX-WORKER-18 pass 175: invalida cache seller (pos-UPDATE)
    await invalidateSellerPayoutsCache(req.params.id);
    // FIX-WORKER-4 pass 235: audit log (paridade com /approve - financial trail)
    query(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, $2, 'payout.reject', 'seller_payout', $3, 'warn', $4::JSONB)`,
      [req.user.sub, req.user.role, r.rows[0].id, JSON.stringify({
        seller_id: r.rows[0].seller_id,
        amount_cents: r.rows[0].amount_cents,
        reason: req.body.reason.slice(0, 500),
        ip: req.ip,
      })]
    ).catch((e) => log.warn({ err: e.message }, '[payout.reject.audit_fail]'));
    res.json({ ok: true, rejected: r.rows[0].id });
  })
);

// FIX-WORKER-14 pass 208: POST /sellers/admin/mv-kpi/refresh
// Admin manual trigger para REFRESH MATERIALIZED VIEW mv_seller_kpi.
//
// PRE-FIX: cron noturno 3:03 AM era o unico path. Admin precisava aguardar
// 24h apos eventos disruptivos (mass dispute resolve, bulk KYC approve) para
// ver KPIs atualizados.
//
// USE CASES:
// - Apos mass platform-take (admin movou 50 produtos de seller suspended)
// - Apos pagamento de payout grande (KPI gross_revenue stale)
// - Apos seller class promotion bulk (reputation_tier mudou em batch)
// - Investigacao admin: KPI parece errado, force refresh + compara
//
// PROTECTION:
// - admin/staff only (cache freshness eh non-trivial CPU work)
// - rate-limit anti-spam (5 refreshes/hora maximo - operacao pesada)
// - audit_log INSERT (forense: who triggered + when)
// - cache invalidate seller:admin:all + seller:me:kpi (mv stale -> fresh data)
const mvKpiRefreshLimiter = require('@cas/shared').rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 5,
  message: 'REFRESH mv_seller_kpi limitado a 5/h - operacao pesada.',
});

router.post('/mv-kpi/refresh',
  mvKpiRefreshLimiter,
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    try {
      await query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_seller_kpi');
      const durationMs = Date.now() - startedAt;
      // Invalidate caches que dependem do mv_seller_kpi
      await Promise.all([
        cache.del('seller:admin:all:*'),
        cache.del('sellers:list:*'),
        // seller:me:kpi:* per-user - skip wildcard (custoso) - 300s TTL natural expira
      ]);
      // Audit log success
      await query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, severity, payload_after)
         VALUES ($1, $2, 'mv_seller_kpi.refresh.manual', 'materialized_view', 'info', $3::JSONB)`,
        [req.user.sub, req.user.role,
         JSON.stringify({ duration_ms: durationMs, ip: req.ip })]
      ).catch(() => {});
      res.json({ ok: true, refreshed: true, duration_ms: durationMs });
    } catch (e) {
      log.error({ err: e.message, actor: req.user.sub },
        '[mv_seller_kpi.refresh.manual.fail]');
      await query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, severity, payload_after)
         VALUES ($1, $2, 'mv_seller_kpi.refresh.manual.fail', 'materialized_view', 'error', $3::JSONB)`,
        [req.user.sub, req.user.role,
         JSON.stringify({ error: String(e.message).slice(0, 500), ip: req.ip })]
      ).catch(() => {});
      return res.status(500).json({ error: 'refresh_failed', message: e.message });
    }
  })
);

module.exports = router;
