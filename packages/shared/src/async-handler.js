'use strict';

/**
 * Wrapper para route handlers async. Captura erros e repassa pro errorMiddleware.
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
module.exports.asyncHandler = asyncHandler;
