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

function errorMiddleware(err, req, res, _next) {
  const status = err.status || 500;
  const code   = err.code   || 'internal_error';
  const requestId = req.requestId || req.headers['x-request-id'];
  if (status >= 500) {
    logger.error({ err: { code: err.code, msg: err.message, stack: err.stack }, requestId, path: req.originalUrl }, '[error]');
  } else {
    logger.warn({ code, msg: err.message, requestId, path: req.originalUrl }, '[warn]');
  }
  res.status(status).json({
    error: code,
    message: err.message,
    details: err.details,
    requestId,
  });
}

module.exports = {
  HttpError,
  badRequest, unauthorized, forbidden, notFound, conflict, tooMany, serverError,
  notFoundHandler,
  errorMiddleware,
};
