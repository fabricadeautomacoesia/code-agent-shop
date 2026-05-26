'use strict';

const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { query } = require('@cas/db-client');
const { jwt, asyncHandler, errorHandler, logger } = require('@cas/shared');

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

// POST /products/upload/package - upload do ZIP/JSON do produto
router.post('/package', upload.single('file'), asyncHandler(async (req, res, next) => {
  if (!req.file) return next(errorHandler.badRequest('no_file'));
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(req.file.path);
  for await (const chunk of stream) hash.update(chunk);
  const sha = hash.digest('hex');
  const fileUrl = `/uploads/${path.basename(req.file.path)}`;
  log.info({ user: req.user.sub, size: req.file.size, sha }, '[upload.package]');
  res.json({
    file: req.file.filename,
    url: fileUrl,
    size_bytes: req.file.size,
    sha256: sha,
  });
}));

// POST /products/upload/media - imagens/videos
router.post('/media', upload.single('file'), asyncHandler(async (req, res, next) => {
  if (!req.file) return next(errorHandler.badRequest('no_file'));
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
