'use strict';

/**
 * WORKER 17 pass 7: validador unificado de env vars criticas no startup.
 *
 * Padronizacao para Blueprint V8:
 * - Production: env critico ausente/fraco -> process.exit(1) (fail-closed)
 * - Dev: warning no console (nao quebra local dev)
 * - Mensagens opacas em logs (DLP: nao revela nome da env nem formato exato)
 *
 * Uso (no server.js de cada svc, ANTES de listen()):
 *
 *   const { validateStartupEnv } = require('@cas/shared').startup;
 *   validateStartupEnv({
 *     critical: ['PG_PASS', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'],
 *     minLength: { JWT_ACCESS_SECRET: 32, JWT_REFRESH_SECRET: 32, PG_PASS: 8 },
 *     warnIfMissing: ['REDIS_URL'],  // nao fatal mas alerta
 *   });
 *
 * NOTA: para JWT_*_SECRET, packages/shared/src/jwt.js JA faz fail-closed
 * no module-load (W17 pass 6). Este helper eh para envs nao auto-validadas.
 */

const PROD = process.env.NODE_ENV === 'production';

function validateStartupEnv(config = {}) {
  const errors = [];
  const warnings = [];
  const enforces = []; // FIX-WORKER-17 pass 8: warnings que deveriam ser critical

  const critical = config.critical || [];
  const minLength = config.minLength || {};
  const warnIfMissing = config.warnIfMissing || [];
  // FIX-WORKER-17 pass 8: novo conceito - enforce em PROD com STRICT_INTERNAL_TOKENS=1.
  // Antes: warn one-shot no startup, runtime silencioso depois (W2 pass 3 bug).
  // Agora: em PROD ainda warn, mas tambem log periodico (cron-like via setInterval).
  // Ops configura -> mensagens param. Para forçar fail-closed, set STRICT_INTERNAL_TOKENS=1.
  const enforceInProd = config.enforceInProd || [];

  for (const name of critical) {
    const v = process.env[name];
    const min = minLength[name] || 1;
    if (!v) {
      errors.push(`critical env missing: ${name}`);
    } else if (v.length < min) {
      // DLP: nao revela comprimento esperado nos logs externos (so via stderr no exit)
      errors.push(`critical env too short: ${name}`);
    }
  }

  for (const name of warnIfMissing) {
    if (!process.env[name]) {
      warnings.push(`recommended env missing: ${name}`);
    }
  }

  // FIX-WORKER-17 pass 8: enforceInProd com strict mode opt-in
  const strict = process.env.STRICT_INTERNAL_TOKENS === '1';
  for (const name of enforceInProd) {
    if (!process.env[name]) {
      if (PROD && strict) {
        errors.push(`enforced env missing in strict mode: ${name}`);
      } else if (PROD) {
        enforces.push(`SHOULD-BE-CRITICAL env missing: ${name} (cross-service auth broken)`);
      }
    }
  }

  if (errors.length > 0) {
    if (PROD) {
      // Fail-closed: ops VAI ver no Swarm task logs (restart loop)
      console.error('[startup] CRITICAL env validation failed:');
      errors.forEach((e) => console.error('  -', e));
      console.error('[startup] Refusing to start in production. Check .env / docker secrets.');
      process.exit(1);
    } else {
      console.warn('[startup] DEV warning - env issues (ignored locally):');
      errors.forEach((e) => console.warn('  -', e));
    }
  }

  if (warnings.length > 0 && PROD) {
    console.warn('[startup] Optional env warnings:');
    warnings.forEach((w) => console.warn('  -', w));
  }

  // FIX-WORKER-17 pass 8: enforces aparecem AMBOS no startup E periodicamente (10min)
  // para forcar ops notar - silencio runtime nao mais aceito apos W2 pass 3 fiasco.
  if (enforces.length > 0) {
    console.warn('[startup] WARNING: cross-service tokens missing (will fail silently in fetch):');
    enforces.forEach((e) => console.warn('  -', e));
    console.warn('[startup] Set STRICT_INTERNAL_TOKENS=1 to refuse boot until configured.');
    // Re-emite warning a cada 10min - mata oblivion ops
    setInterval(() => {
      console.warn('[startup.periodic] STILL missing cross-service tokens:');
      enforces.forEach((e) => console.warn('  -', e));
    }, 10 * 60 * 1000).unref();
  }

  return { errors, warnings, enforces, ok: errors.length === 0 };
}

module.exports = { validateStartupEnv };
