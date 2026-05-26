'use strict';

const crypto = require('crypto');

/**
 * AES-256-GCM para cofre de API keys (V8 22.1).
 * Key vem de VAULT_AES_KEY (.env), 32 bytes hex (64 chars).
 */
const ALG = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;

function getKey() {
  const hex = process.env.VAULT_AES_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('[crypto] VAULT_AES_KEY ausente ou invalida (precisa 64 chars hex = 32 bytes).');
  }
  return Buffer.from(hex, 'hex');
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
