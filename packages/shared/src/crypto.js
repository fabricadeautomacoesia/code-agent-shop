'use strict';

const crypto = require('crypto');

/**
 * AES-256-GCM para cofre de API keys (V8 22.1).
 * Key vem de VAULT_AES_KEY (.env), 32 bytes hex (64 chars).
 */
const ALG = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;

// FIX-WORKER-17 pass 5: validacao mais estrita + cache + DLP error message.
// Antes:
// 1. Validava so length===64, nao verificava se eh hex valido (Buffer.from
//    aceita "GGGG..." e retorna bytes zerados -> key fraca aceita).
// 2. Mensagem de erro revelava env var name e formato esperado.
// 3. Chamava process.env + Buffer.from em CADA encrypt/decrypt (microopt).
const HEX_RE = /^[0-9a-fA-F]{64}$/;
let _cachedKey = null;
function getKey() {
  if (_cachedKey) return _cachedKey;
  const hex = process.env.VAULT_AES_KEY;
  if (!hex || !HEX_RE.test(hex)) {
    // DLP: mensagem opaca. Operador ve em logs e investiga env config.
    // requestId no errorHandler ja correlaciona com a stack server-side.
    throw new Error('[crypto] encryption key misconfigured');
  }
  _cachedKey = Buffer.from(hex, 'hex');
  return _cachedKey;
}

function encrypt(plaintext) {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv,
    tag: tag,
    iv_base64: iv.toString('base64'),
    tag_base64: tag.toString('base64'),
  };
}

function decrypt({ encrypted, iv, tag }) {
  const key = getKey();
  const ivBuf  = Buffer.isBuffer(iv)  ? iv  : Buffer.from(iv,  'base64');
  const tagBuf = Buffer.isBuffer(tag) ? tag : Buffer.from(tag, 'base64');
  const decipher = crypto.createDecipheriv(ALG, key, ivBuf);
  decipher.setAuthTag(tagBuf);
  const data = Buffer.from(encrypted, 'base64');
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function genKeyAES256() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = { encrypt, decrypt, sha256, randomHex, genKeyAES256 };
