'use strict';

const logger = require('./logger').default;

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function badRequest(code, msg, details)     { return new HttpError(400, code, msg, details); }
function unauthorized(code, msg)             { return new HttpError(401, code, msg); }
function forbidden(code, msg)                { return new HttpError(403, code, msg); }
function notFound(code, msg)                 { return new HttpError(404, code, msg); }
function conflict(code, msg, details)        { return new HttpError(409, code, msg, details); }
function tooMany(code, msg)                  { return new HttpError(429, code, msg); }
function serverError(code, msg, details)     { return new HttpError(500, code, msg, details); }

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'route_not_found', path: req.originalUrl });
}

// FIX-WORKER-7: errors do Postgres (codigo SQLSTATE 5 chars) NUNCA devem vazar
// nome de tabela/constraint/coluna ao cliente (reconnaissance). Sanitize aqui.
const PG_SQLSTATE_RE = /^[0-9A-Z]{5}$/;
function isPgError(err) {
  return err && typeof err.code === 'string' && PG_SQLSTATE_RE.test(err.code);
}

function errorMiddleware(err, req, res, _next) {
  const status = err.status || (isPgError(err) ? 500 : 500);
  const code   = err.code   || 'internal_error';
  const requestId = req.requestId || req.headers['x-request-id'];

  if (status >= 500) {
    // log COMPLETO server-side (com nomes de tabela/constraint para debug)
    logger.error({ err: { code: err.code, msg: err.message, stack: err.stack, detail: err.detail, table: err.table, constraint: err.constraint }, requestId, path: req.originalUrl }, '[error]');
  } else {
    logger.warn({ code, msg: err.message, requestId, path: req.originalUrl }, '[warn]');
  }

  // Resposta cliente: sanitizada se for erro PG cru, opaca se status>=500
  let outCode = code;
  let outMessage = err.message;
  if (isPgError(err) || status >= 500) {
    outCode = isPgError(err) ? 'database_error' : (code === 'internal_error' ? 'internal_error' : code);
    outMessage = 'Erro interno do servidor. Tente novamente em instantes.';
  }

  res.status(status).json({
    error: outCode,
    message: outMessage,
    details: status < 500 ? err.details : undefined,
    requestId,
  });
}

module.exports = {
  HttpError,
  badRequest, unauthorized, forbidden, notFound, conflict, tooMany, serverError,
  notFoundHandler,
  errorMiddleware,
};
