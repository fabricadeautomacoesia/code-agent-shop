'use strict';

const express = require('express');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler } = require('@cas/shared');

const router = express.Router();
router.use(jwt.requireAuth());

router.get('/', asyncHandler(async (req, res) => {
  const r = await query(
    `SELECT u.id, u.email, u.full_name, u.display_name, u.role, u.avatar_url, u.locale, u.timezone,
            u.is_email_verified, u.is_phone_verified, u.created_at,
            (SELECT is_enabled FROM user_two_factor WHERE user_id = u.id) AS twofa_enabled,
            (SELECT to_jsonb(s) - 'metadata' FROM sellers s WHERE s.user_id = u.id) AS seller_profile
     FROM users u
     WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [req.user.sub]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'user_not_found' });
  res.json({ user: r.rows[0] });
}));

router.patch('/', asyncHandler(async (req, res) => {
  const allowed = ['full_name','display_name','avatar_url','bio','locale','timezone','phone_e164'];
  const cols = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      cols.push(`${k} = $${i++}`);
      vals.push(req.body[k]);
    }
  }
  if (!cols.length) return res.json({ ok: true, noop: true });
  vals.push(req.user.sub);
  await query(`UPDATE users SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $${i}`, vals);
  res.json({ ok: true });
}));

module.exports = router;
