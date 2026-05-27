'use strict';

const express = require('express');
const { query, tx } = require('@cas/db-client');
const { jwt, asyncHandler, errorHandler, logger } = require('@cas/shared');

const router = express.Router();
const log = logger.child({ svc: 'order-svc', mod: 'download' });
router.use(jwt.requireAuth());

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// FIX-WORKER-7 pass 20: download_token security audit completo.
// Limite default 50 downloads/lifetime - sufficient p/ usos legitimos
// (HD swap, OS reinstall, multi-device, family share) MAS impede abuso
// distribuicao torrent. MLB/Steam/Asaas: caps similares 10-100.
// Pode ser sobrescrito por produto futuramente via products.max_downloads col.
const DEFAULT_DOWNLOAD_LIMIT = 50;

// GET /orders/download/:token - gera URL assinada do pacote do produto comprado
//
// 5 BUGS CORRIGIDOS (Pattern W7 11 regras + security):
//
// 1. *** SECURITY *** sem download_count LIMIT (era infinito)
//    User comprava produto, baixava 10k vezes, distribuia torrent.
//    Backend incrementava count mas NUNCA verificava limite.
//    Bug severo monetizacao + DMCA risk.
//    FIX: cap DEFAULT_DOWNLOAD_LIMIT (50) - rejeita pos-limit com 403.
//    Bonus: response include downloads_remaining para UI mostrar contador.
//
// 2. *** RACE CONDITION (Regra K) *** SELECT + 2 UPDATEs sem FOR UPDATE
//    User dispara 100 downloads simultaneos. SELECT le count=49 (proximo
//    do cap). 100 paralelos validam count<50 (todos passam). 100 UPDATEs
//    incrementam concorrente -> count vai pra 149 mas todos 100 receberam
//    o package_url. BYPASS DO CAP.
//    FIX: tx() com SELECT FOR UPDATE em order_items - lock pessimistico.
//    Segunda request bloqueia ate primeira terminar -> serializacao real.
//    Pattern W7 Regra K consolidado (orders.js checkout + cart.js redeem).
//
// 3. *** SECURITY *** JOIN products SEM deleted_at filter
//    Cenario CRITICO: produto deletado por violacao DMCA/legal/QA-reject.
//    Buyer com download_token ainda ativo recebia package_url -> vazamento
//    de conteudo ilegal/banido. Soft delete deveria invalidar downloads.
//    FIX: AND p.deleted_at IS NULL. Buyer recebe 410 'product_unavailable'
//    com mensagem clara (nao 404 que sugere bug).
//
// 4. Token format validation - sem regex UUID upfront
//    User envia 'abc' -> PG 22P02 invalid uuid syntax -> errorHandler 500
//    generico. FIX: UUID_RE.test() upfront -> 404 limpo.
//
// 5. UPDATEs separados em queries distintas (linha 27-29 pre-fix)
//    Se primeiro UPDATE OK mas segundo falhar (network/lock), state
//    inconsistente: count++ mas order status nao virou 'fulfilled'.
//    FIX: ambos UPDATEs dentro de tx() atomic + audit log entry.

router.get('/:token', asyncHandler(async (req, res, next) => {
  // FIX bug 4: UUID validation upfront (evita 22P02 -> 500 generico)
  if (!UUID_RE.test(req.params.token)) {
    return next(errorHandler.notFound('download_not_found'));
  }

  // FIX bug 2+5: tx() atomic + FOR UPDATE para serializacao race-safe
  let response;
  await tx(async (c) => {
    // FIX bug 3: p.deleted_at IS NULL no JOIN (anti DMCA/legal leak)
    // FIX bug 2: SELECT FOR UPDATE em order_items - lock anti-race
    // Pattern Regra K: WRITE path em resource mutavel (download_count).
    const r = await c.query(
      `SELECT oi.id, oi.product_id, oi.license_key, oi.download_count,
              oi.download_expires_at, oi.order_id,
              o.status AS order_status,
              p.package_url, p.title, p.deleted_at AS product_deleted_at
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
        WHERE oi.download_token = $1 AND o.buyer_user_id = $2
        FOR UPDATE OF oi`,
      [req.params.token, req.user.sub]
    );
    if (!r.rows.length) {
      response = { error: 'not_found' };
      return;
    }
    const item = r.rows[0];

    // FIX bug 3: produto deletado (DMCA/legal/QA-reject) -> 410 Gone
    if (item.product_deleted_at) {
      response = { error: 'product_unavailable' };
      return;
    }

    if (!['paid','fulfilled'].includes(item.order_status)) {
      response = { error: 'order_not_paid' };
      return;
    }

    if (new Date(item.download_expires_at) < new Date()) {
      response = { error: 'download_expired' };
      return;
    }

    if (!item.package_url) {
      response = { error: 'package_not_set' };
      return;
    }

    // FIX bug 1: cap download_count - rejeita pos-limit
    const currentCount = parseInt(item.download_count || 0, 10);
    if (currentCount >= DEFAULT_DOWNLOAD_LIMIT) {
      response = {
        error: 'download_limit_exceeded',
        limit: DEFAULT_DOWNLOAD_LIMIT,
        count: currentCount,
      };
      return;
    }

    // FIX bug 5: ambos UPDATEs dentro do mesmo tx() - atomico
    await c.query(
      `UPDATE order_items SET download_count = download_count + 1 WHERE id = $1`,
      [item.id]
    );
    await c.query(
      `UPDATE orders SET fulfilled_at = COALESCE(fulfilled_at, NOW()),
                          status = 'fulfilled'
        WHERE id = $1`,
      [item.order_id]
    );

    // FIX bug 5 bonus: audit log de cada download (auditoria + anti-fraude)
    // - Permite admin investigar padroes abuso futuros
    // - Permite seller ver downloads (transparencia)
    try {
      await c.query(
        `INSERT INTO audit_log (actor_user_id, actor_role, action, target_type, target_id, severity)
         VALUES ($1, $2, 'product.download', 'order_item', $3, 'info')`,
        [req.user.sub, req.user.role || 'buyer', item.id]
      );
    } catch (e) {
      // audit log fail nao quebra download (graceful)
      log.warn({ err: e.message, item_id: item.id }, '[download.audit_fail]');
    }

    response = {
      ok: true,
      download_url: item.package_url,
      license_key: item.license_key,
      title: item.title,
      expires_at: item.download_expires_at,
      download_count: currentCount + 1,
      downloads_remaining: DEFAULT_DOWNLOAD_LIMIT - (currentCount + 1),
    };
  });

  // FIX bug 5: error mapping fora do tx() (mesmo pattern cart.js pass 19)
  if (response?.error) {
    if (response.error === 'not_found')             return next(errorHandler.notFound('download_not_found'));
    if (response.error === 'product_unavailable')   return res.status(410).json({ error: 'product_unavailable', message: 'Este produto nao esta mais disponivel.' });
    if (response.error === 'order_not_paid')        return next(errorHandler.forbidden('order_not_paid'));
    if (response.error === 'download_expired')      return next(errorHandler.forbidden('download_expired'));
    if (response.error === 'package_not_set')       return next(errorHandler.notFound('package_not_set'));
    if (response.error === 'download_limit_exceeded') return res.status(403).json(response);
    // Fallback anti-novel-error (mesmo pattern cart.js pass 19)
    return res.status(500).json({ error: 'download_failed', detail: response.error });
  }
  res.json(response);
}));

module.exports = router;
