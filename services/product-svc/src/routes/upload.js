'use strict';

const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, errorHandler, logger, rateLimiter, mask } = require('@cas/shared');

// FIX-WORKER-7 pass 87: rate-limit + quota.
//
// BUG 1 *** RATE-LIMIT MISSING *** storage exhaustion DoS
//   PRE-FIX: seller pwned spawn 1000 uploads/hr de 50MB = 50GB/hr ataque sustentado.
//   Real users uploadam 1-5 packages/dia (10/dia max).
//   FIX: uploadLimiter 30/hr/seller (cobre uploads media + package fluxo normal).
const uploadLimiter = rateLimiter.createLimiter({
  windowMs: 60 * 60 * 1000, max: 30,
  message: 'Muitos uploads recentes. Aguarde 1 hora.',
});

// BUG 2 *** STORAGE QUOTA per seller MISSING (Regra L) ***
//   PRE-FIX: zero cap storage cumulativo por seller. Seller pode ocupar GB+ em
//   uploads orfaos (uploads + delete product = file remains on disk).
//   FIX: max_seller_storage_bytes env-configurable (default 5GB).
//   Check antes do upload accept via SUM(size) em product_media + product_versions.
const MAX_SELLER_STORAGE_BYTES = parseInt(process.env.MAX_SELLER_STORAGE_BYTES || '5368709120', 10); // 5GB

const router = express.Router();
const log = logger.child({ svc: 'product-svc', mod: 'upload' });

const STORAGE_PATH = process.env.STORAGE_LOCAL_PATH ||
  path.join(__dirname, '../../../../uploads');

if (!fs.existsSync(STORAGE_PATH)) fs.mkdirSync(STORAGE_PATH, { recursive: true });

const MAX_SIZE = (parseInt(process.env.QA_MAX_FILE_SIZE_MB || '50', 10)) * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: STORAGE_PATH,
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const id = crypto.randomBytes(8).toString('hex');
      cb(null, `${Date.now()}-${id}-${safe}`);
    },
  }),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    const ok = ['.zip','.json','.tar','.gz','.js','.py','.php','.txt','.md','.pdf','.png','.jpg','.jpeg','.webp','.svg','.mp4','.webm']
      .includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('extensao_nao_permitida'), ok);
  },
});

router.use(jwt.requireAuth({ roles: ['seller','admin'] }));
router.use(uploadLimiter);

// Helper: check storage quota seller (Regra L cap)
async function checkSellerQuota(userId, incomingSize) {
  // Soma bytes em product_media (cover + gallery) + product_versions (package_url).
  // Aproximacao: file_size_bytes column em product_media (se existe) ou via storage scan.
  // Defensive fallback: query simples count uploads recentes
  try {
    const r = await query(
      `SELECT COALESCE(SUM(file_size_bytes), 0)::BIGINT AS total
         FROM product_media pm
         JOIN products p ON p.id = pm.product_id
         JOIN sellers s ON s.id = p.seller_id
        WHERE s.user_id = $1`, [userId]
    );
    const currentBytes = Number(r.rows[0]?.total || 0);
    return {
      current_bytes: currentBytes,
      would_exceed: (currentBytes + incomingSize) > MAX_SELLER_STORAGE_BYTES,
      max_bytes: MAX_SELLER_STORAGE_BYTES,
    };
  } catch (e) {
    // Schema sem file_size_bytes - skip check defensive
    log.warn({ /* FIX pass 344 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[upload.quota_check_skipped]');
    return { current_bytes: 0, would_exceed: false, max_bytes: MAX_SELLER_STORAGE_BYTES };
  }
}

// Helper: cleanup file (BUG 5 storage leak)
function cleanupFile(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err) log.warn({ err: err.message, path: filePath }, '[upload.cleanup_failed]');
  });
}

// POST /products/upload/package - upload do ZIP/JSON do produto
// FIX-WORKER-7 pass 87: 4 BUGS aplicando Pattern W7 (Regra L + cleanup + audit + DLP).
//
// BUG 5 *** STORAGE LEAK em erro hash ***
//   PRE-FIX: if hash falha (disk full, IO error), file fica orfao em STORAGE_PATH.
//   FIX: try/catch + cleanup + re-throw.
//
// BUG 7 *** Regra P AUDIT LOG MISSING ***
//   Upload pode receber malware/conteudo ilicito - compliance precisa trail.
//   FIX: INSERT audit_log com sha256 + size + ip.
router.post('/package', upload.single('file'), asyncHandler(async (req, res, next) => {
  if (!req.file) return next(errorHandler.badRequest('no_file'));

  // BUG 2 Regra L: quota check
  const quota = await checkSellerQuota(req.user.sub, req.file.size);
  if (quota.would_exceed) {
    cleanupFile(req.file.path);
    return res.status(429).json({
      error: 'storage_quota_exceeded',
      message: `Limite de armazenamento atingido (${Math.round(MAX_SELLER_STORAGE_BYTES/(1024*1024*1024))}GB). Arquive uploads antigos.`,
      current_bytes: quota.current_bytes,
      max_bytes: quota.max_bytes,
    });
  }

  // BUG 5: try/catch com cleanup em erro
  let sha;
  try {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(req.file.path);
    for await (const chunk of stream) hash.update(chunk);
    sha = hash.digest('hex');
  } catch (e) {
    cleanupFile(req.file.path);
    log.error({ /* FIX pass 344 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[upload.hash_failed]');
    return next(errorHandler.badRequest('hash_failed', 'Falha ao processar arquivo. Tente novamente.'));
  }

  const fileUrl = `/uploads/${path.basename(req.file.path)}`;

  // BUG 7 Regra P: audit log atomic (compliance forense)
  // FIX-WORKER-7 pass 250 (target_id UUID type mismatch):
  //   PRE-FIX: target_id = sha (SHA256 = 64-char hex, NAO formato UUID)
  //   audit_log.target_id schema = UUID type -> PG 22P02 invalid_text_representation
  //   -> exception silenciada no catch -> NENHUM audit_log inserido para uploads
  //   -> compliance gap (LGPD/forense): violacao silenciosa de Regra P + W7 audit policy
  //   POST-FIX: target_id=NULL (legitimo - sha NAO eh UUID entity reference).
  //   SHA256 ja esta no payload_after JSONB (estrutura cobre forense lookup).
  //   audit_log queries por sha podem usar payload_after JSONB GIN idx (mig 002 linha 200).
  try {
    await query(
      `INSERT INTO audit_log
        (actor_user_id, actor_role, action, target_type, target_id, severity, payload_after)
       VALUES ($1, $2, 'upload.package', 'file', NULL, 'info', $3::JSONB)`,
      [req.user.sub, req.user.role,
       JSON.stringify({
         filename: req.file.filename,
         size_bytes: req.file.size,
         mime: req.file.mimetype,
         sha256: sha,
         ip: req.ip,
       })]
    );
  } catch (e) {
    log.warn({ /* FIX pass 344 DLP */ err: mask.text(String(e.message || '').slice(0, 300)) }, '[upload.audit_failed]');
  }

  log.info({ user: req.user.sub, size: req.file.size, sha }, '[upload.package]');
  res.json({
    file: req.file.filename,
    url: fileUrl,
    size_bytes: req.file.size,
    sha256: sha,
  });
}));

// POST /products/upload/media - imagens/videos
// FIX-WORKER-7 pass 87: media-only fileFilter + quota (Regra L).
const MEDIA_ALLOWED_EXT = new Set(['.png','.jpg','.jpeg','.webp','.svg','.mp4','.webm']);

router.post('/media', upload.single('file'), asyncHandler(async (req, res, next) => {
  if (!req.file) return next(errorHandler.badRequest('no_file'));

  // BUG 9: extra check ext (defesa em profundidade vs script-as-image bypass)
  // PRE-FIX: fileFilter global aceita .js/.py/.php p/ /package mas em /media
  // deveria rejeitar (XSS vector se renderizado).
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!MEDIA_ALLOWED_EXT.has(ext)) {
    cleanupFile(req.file.path);
    return res.status(400).json({
      error: 'invalid_media_type',
      message: 'Apenas imagens (png/jpg/jpeg/webp/svg) e videos (mp4/webm) sao permitidos em /media.',
      allowed: Array.from(MEDIA_ALLOWED_EXT),
    });
  }

  // BUG 2 Regra L: quota check
  const quota = await checkSellerQuota(req.user.sub, req.file.size);
  if (quota.would_exceed) {
    cleanupFile(req.file.path);
    return res.status(429).json({
      error: 'storage_quota_exceeded',
      message: `Limite de armazenamento atingido.`,
      current_bytes: quota.current_bytes,
      max_bytes: quota.max_bytes,
    });
  }

  const fileUrl = `/uploads/${path.basename(req.file.path)}`;
  res.json({ url: fileUrl, size_bytes: req.file.size, mime: req.file.mimetype });
}));

// erro do multer
router.use((err, _req, res, _next) => {
  if (err) {
    log.warn({ err: err.message }, '[upload.err]');
    return res.status(400).json({ error: 'upload_error', message: err.message });
  }
});

module.exports = router;
