'use strict';

const express = require('express');
const { z } = require('zod');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, validate, errorHandler, crypto, cache, logger, rateLimiter } = require('@cas/shared');

const log = logger.child({ svc: 'seller-svc', mod: 'me' });
const router = express.Router();
router.use(jwt.requireAuth({ roles: ['seller','admin'] }));

// FIX-WORKER-18 pass 6: helper de invalidacao cache apos mutations de seller.
// W18 pass 5 adicionou cache em /sellers, /:slug, /:slug/stats, /:slug/products
// (TTL 60-180s). Sem invalidacao em PATCH, store_name/description ficavam stale.
async function invalidateSellerCache(userId) {
  try {
    // Lookup store_slug por user_id
    const r = await query('SELECT store_slug FROM sellers WHERE user_id = $1', [userId]);
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

// GET /sellers/me - perfil completo do seller logado
router.get('/', asyncHandler(async (req, res, next) => {
  const r = await query(
    `SELECT s.*, vp.qna_pending, vp.disputes_open, vp.products_in_qa,
            vp.products_rejected, vp.sla_days_remaining
       FROM sellers s
       LEFT JOIN vw_seller_pending vp ON vp.seller_id = s.id
      WHERE s.user_id = $1 AND s.deleted_at IS NULL`,
    [req.user.sub]
  );
  if (!r.rows.length) return next(errorHandler.notFound('seller_profile_not_found'));
  // ocultar fingerprint do documento
  const s = r.rows[0];
  delete s.document_number_hash;
  res.json({ seller: s });
}));

const updateSchema = z.object({
  store_name: z.string().min(3).max(120).optional(),
  store_description: z.string().max(5000).optional(),
  store_banner_url: z.string().url().optional(),
  store_logo_url: z.string().url().optional(),
  asaas_pix_key: z.string().max(200).optional(),
  allow_platform_resale: z.boolean().optional(),
});

router.patch('/', validate({ body: updateSchema }), asyncHandler(async (req, res) => {
  const cols = []; const vals = []; let i = 1;
  for (const [k,v] of Object.entries(req.body)) {
    cols.push(`${k} = $${i++}`); vals.push(v);
  }
  if (!cols.length) return res.json({ ok: true, noop: true });
  vals.push(req.user.sub);
  await query(`UPDATE sellers SET ${cols.join(', ')}, updated_at = NOW() WHERE user_id = $${i}`, vals);
  // FIX-WORKER-18 pass 6: invalida cache para seller veja mudancas imediatamente
  await invalidateSellerCache(req.user.sub);
  res.json({ ok: true });
}));

const kycSchema = z.object({
  document_type: z.enum(['cpf','cnpj']),
  document_number: z.string().min(11).max(20),
  legal_name: z.string().min(3).max(200),
  address_line1: z.string().min(3).max(200),
  address_city: z.string().min(2).max(100),
  address_state: z.string().length(2),
  address_zip: z.string().min(5).max(20),
});

// POST /sellers/me/kyc - submit KYC
router.post('/kyc', validate({ body: kycSchema }), asyncHandler(async (req, res) => {
  const b = req.body;
  const fp = crypto.sha256(b.document_number);
  await query(
    `UPDATE sellers SET
       document_type = $1, document_number_hash = $2, legal_name = $3,
       address_line1 = $4, address_city = $5, address_state = $6, address_zip = $7,
       status = 'active',
       updated_at = NOW()
     WHERE user_id = $8`,
    [b.document_type, fp, b.legal_name, b.address_line1, b.address_city, b.address_state, b.address_zip, req.user.sub]
  );
  res.json({ ok: true, status: 'active' });
}));

// GET /sellers/me/sla-status - timer da Classe B
router.get('/sla-status', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT id, seller_class, sla_active, sla_days, sla_last_upload_at, sla_next_deadline_at,
            sla_revoked_count, status,
            GREATEST(0, EXTRACT(DAY FROM (sla_next_deadline_at - NOW())))::INT AS days_remaining,
            EXTRACT(EPOCH FROM (sla_next_deadline_at - NOW()))::BIGINT AS seconds_remaining
       FROM sellers WHERE user_id = $1`, [req.user.sub]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'not_found' });
  res.json({ sla: r.rows[0] });
}));

// GET /sellers/me/sla-history
router.get('/sla-history', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT h.* FROM seller_sla_history h
       JOIN sellers s ON s.id = h.seller_id
      WHERE s.user_id = $1 ORDER BY h.created_at DESC LIMIT 50`, [req.user.sub]
  );
  res.json({ history: r.rows });
}));

// POST /sellers/me/payout - solicitar saque (REAL MONEY OUT request)
// FIX-WORKER-7 pass 40: 7 BUGS CRITICOS - endpoint solicita REAL $ exit plataforma.
// Pattern paralelo pass 23 (payment /payouts/:id/process - admin processa)
// MAS ESTE = seller REQUEST. Vetor abuse: seller solicita > balance disponivel.
//
// BUG 1 *** SALDO DISPONIVEL CHECK MISSING *** monetary loss real
//   PRE-FIX: zero check balance. Seller pode POST {amount: R$ 1.000.000}
//   sem ter receita. INSERT seller_payouts pending entra no DB.
//   Admin processa (trust DB integrity) -> Asaas transfer real -> LOSS.
//   FIX: calcular available_balance = total_revenue - SUM(payouts non-final)
//   Bloquear se amount > available.
//
// BUG 2 *** INFLIGHT PAYOUT MULTIPLICATION *** race spam
//   PRE-FIX: zero check inflight. Seller dispara 100 requests simultaneos
//   100 INSERTs pending - admin aprova todos sem ver soma cumulativa.
//   FIX: SUM(payouts pending+approved) DENTRO tx + FOR UPDATE sellers row.
//
// BUG 3 *** Regra A *** seller_status check missing
//   Seller suspended/banned/pending_kyc pode pedir saque - bypass compliance
//   FIX: status='active' (whitelist, pre-existing enum pending_kyc/active/...)
//
// BUG 4 *** KYC VERIFICATION *** compliance/AML
//   PRE-FIX: aceita payout em seller status='pending_kyc'
//   = lavagem dinheiro vector + AML violation
//   FIX: WHERE status='active' (enum inclui kyc_required estados)
//
// BUG 5 *** Regra K *** FOR UPDATE seller row anti-race
//   2 requests simultaneos leem mesmo balance -> ambos passam -> race
//   FIX: SELECT FOR UPDATE serializa
//
// BUG 6 *** Regra I *** RETURNING *
//   seller_payouts.* expoe internal_notes/risk_score/rejection_reason
//   FIX: RETURNING explicit fields
//
// BUG 7 *** RATE-LIMIT *** seller pwned spam
//   Conta seller compromised -> spam payouts. FIX: rateLimiter 3/hr/IP
//   (real users <1 payout/dia)
const payoutLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 3,
  message: 'Muitas solicitacoes de saque recentes. Aguarde 1 hora.',
});

router.post('/payout',
  payoutLimiter,
  validate({ body: z.object({ amount_cents: z.number().int().positive() }) }),
  asyncHandler(async (req, res, next) => {
    let outcome;
    let payout;
    await tx(async (c) => {
      // BUG 5 Regra K: SELECT FOR UPDATE seller (serializa concorrencia)
      // BUG 3+4 Regras A+KYC: status='active' filter (pending_kyc/suspended blocked)
      // BUG 2 inflight: total_revenue - SUM payouts non-final
      const sql = `
        WITH non_final AS (
          SELECT COALESCE(SUM(amount_cents), 0)::BIGINT AS pending_sum
            FROM seller_payouts
           WHERE seller_id = (SELECT id FROM sellers WHERE user_id = $1::UUID)
             AND status IN ('pending','approved','processing','paid')
        )
        SELECT s.id, s.payout_min_amount_cents, s.total_revenue_cents,
               s.status, (SELECT pending_sum FROM non_final) AS reserved_cents
          FROM sellers s
         WHERE s.user_id = $1::UUID
         FOR UPDATE OF s
      `;
      const sr = await c.query(sql, [req.user.sub]);
      if (!sr.rows.length) { outcome = { error: 'seller_not_found' }; return; }
      const s = sr.rows[0];

      // BUG 3+4: status='active' (compliance + KYC)
      if (s.status !== 'active') {
        outcome = { error: 'seller_not_active', current_status: s.status };
        return;
      }

      const min = parseInt(s.payout_min_amount_cents, 10) || 5000;
      if (req.body.amount_cents < min) {
        outcome = { error: 'amount_below_min', min_cents: min };
        return;
      }

      // BUG 1+2: calcula saldo disponivel real (revenue - payouts non-final)
      const totalRev = parseInt(s.total_revenue_cents, 10) || 0;
      const reserved = parseInt(s.reserved_cents, 10) || 0;
      const available = totalRev - reserved;
      if (req.body.amount_cents > available) {
        outcome = {
          error: 'insufficient_balance',
          available_cents: available,
          requested_cents: req.body.amount_cents,
        };
        return;
      }

      // INSERT payout (Regra I: RETURNING explicit)
      const r = await c.query(
        `INSERT INTO seller_payouts (seller_id, amount_cents)
         VALUES ($1::UUID, $2::BIGINT)
         RETURNING id, amount_cents, status, requested_at`,
        [s.id, req.body.amount_cents]
      );
      payout = r.rows[0];

      // BONUS audit_log atomic (pattern pass 23 - real money endpoints)
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
         VALUES ($1, 'seller', 'payout.request', 'seller_payout', $2, 'info', $3::JSONB)`,
        [req.user.sub, payout.id,
         JSON.stringify({
           seller_id: s.id,
           amount_cents: req.body.amount_cents,
           available_before: available,
           ip: req.ip,
         })]
      );
    });

    if (outcome?.error === 'seller_not_found') return next(errorHandler.notFound('seller_not_found'));
    if (outcome?.error === 'seller_not_active') {
      return res.status(403).json({
        error: 'seller_not_active',
        message: `Sua conta esta em status '${outcome.current_status}'. Saques disponiveis apenas para sellers ativos com KYC aprovado.`,
        current_status: outcome.current_status,
      });
    }
    if (outcome?.error === 'amount_below_min') {
      return res.status(400).json({
        error: 'amount_below_min',
        message: `Minimo R$ ${(outcome.min_cents / 100).toFixed(2)}`,
        min_cents: outcome.min_cents,
      });
    }
    if (outcome?.error === 'insufficient_balance') {
      return res.status(400).json({
        error: 'insufficient_balance',
        message: `Saldo disponivel: R$ ${(outcome.available_cents / 100).toFixed(2)}. Solicitado: R$ ${(outcome.requested_cents / 100).toFixed(2)}.`,
        available_cents: outcome.available_cents,
        requested_cents: outcome.requested_cents,
      });
    }
    res.status(201).json({ payout });
  })
);

// FIX-WORKER-5: GET /sellers/me/payouts - historico de payouts do seller logado.
// Antes: dashboard-seller /financeiro tinha botao "Solicitar saque" mas zero
// visibilidade do que aconteceu depois (admin aprovou? rejeitou? processou?).
// Seller ficava no escuro apos solicitar - tinha que perguntar suporte.
router.get('/payouts', asyncHandler(async (req, res, next) => {
  // FIX-WORKER-7 pass 4: Math.max(1, ...) clamp p/ rejeitar negativos
  const lim = Math.max(1, Math.min(parseInt(req.query.limit || '50', 10), 200));
  const s = await query('SELECT id FROM sellers WHERE user_id = $1', [req.user.sub]);
  if (!s.rows.length) return next(errorHandler.notFound('seller_not_found'));
  const r = await query(
    `SELECT id, amount_cents, status, asaas_transfer_id, requested_at,
            approved_at, paid_at, rejected_reason
       FROM seller_payouts
      WHERE seller_id = $1
      ORDER BY requested_at DESC LIMIT $2`,
    [s.rows[0].id, lim]
  );
  res.json({ payouts: r.rows, count: r.rows.length });
}));

// GET /sellers/me/kpi
router.get('/kpi', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT k.* FROM mv_seller_kpi k
       JOIN sellers s ON s.id = k.seller_id
      WHERE s.user_id = $1`, [req.user.sub]
  );
  res.json({ kpi: r.rows[0] || null });
}));

module.exports = router;
