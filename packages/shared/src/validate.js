'use strict';

const { z } = require('zod');
const { badRequest } = require('./error-handler');

/**
 * Middleware zod: validate({ body: ZodSchema, query: ..., params: ... })
 */
function validate(schemas) {
  return (req, _res, next) => {
    try {
      if (schemas.body)   req.body   = schemas.body.parse(req.body);
      if (schemas.query)  req.query  = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      next(badRequest('validation_error', 'Falha de validacao', err.errors || err.message));
    }
  };
}

module.exports = validate;
module.exports.validate = validate;
module.exports.z = z;
