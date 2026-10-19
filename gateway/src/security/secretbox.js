// Encrypt upstream credentials at rest with AES-256-GCM.
// Why: a stolen SQLite file / PVC snapshot must not reveal upstream tokens.
// The master key comes from the environment (a Kubernetes Secret), never from the DB.
// Stored format:  v1.<iv b64url>.<tag b64url>.<ciphertext b64url>
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export function parseMasterKey(b64) {
  const key = Buffer.from(b64 ?? '', 'base64');
  if (key.length !== 32) throw new Error('GATEWAY_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return key;
}

export function encrypt(plaintext, key) {
  const iv = randomBytes(12); // GCM standard nonce size; fresh per message (never reuse with same key)
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(blob, key) {
  const [v, iv, tag, ct] = String(blob).split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('bad ciphertext format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url')); // GCM tag = tamper detection; wrong key/edited data throws
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
