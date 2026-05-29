'use strict';

module.exports = {
  logger:       require('./logger'),
  sanitize:     require('./sanitize'),
  withRetry:    require('./with-retry'),
  jwt:          require('./jwt'),
  crypto:       require('./crypto'),
  mask:         require('./mask'),
  fail2ban:     require('./fail2ban'),
  errorHandler: require('./error-handler'),
  asyncHandler: require('./async-handler'),
  validate:     require('./validate'),
  rateLimiter:  require('./rate-limiter'),
  llmFallback:  require('./llm-fallback'),
  cache:        require('./cache'),
  // FIX-WORKER-13 pass 467: notif-cache helper cross-svc DRY (30+ INSERT sites)
  notifCache:   require('./notif-cache'),
  paginate:     require('./paginate'),
  startup:      require('./startup'),
  // FIX-WORKER-7 pass 52: HTML escape DRY cross-svc (consolida 3 implementations
  // duplicadas em notification-svc renderMustache + auth-svc forgot/register).
  htmlEscape:   require('./html-escape').htmlEscape,
  // FIX-WORKER-7 pass 58: LGPD PII display masking DRY cross-svc (consolida
  // maskEmail/maskName duplicados em review-svc pass 56/57. Semantica DIFFERENT
  // de ./mask.js (que é DLP secrets em logs - sk-/Bearer/JWT regex).
  maskPII:      require('./mask-pii'),
  sleep:        (ms) => new Promise((r) => setTimeout(r, ms)),
};
