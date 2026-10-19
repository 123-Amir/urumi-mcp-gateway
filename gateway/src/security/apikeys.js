// API key generation + hashing.
// Format:  umk_<8-char public prefix>_<43-char secret>
//   - prefix  : safe to show in UI/audit so a user can tell keys apart
//   - secret  : 32 random bytes (256-bit) from the OS CSPRNG, base64url encoded
// Only sha256(fullKey) is stored. The raw key is returned ONCE at creation time.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const KEY_RE = /^umk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/;

export function generateApiKey() {
  const prefix = randomBytes(6).toString('base64url').slice(0, 8);
  const secret = randomBytes(32).toString('base64url'); // 43 chars
  const raw = `umk_${prefix}_${secret}`;
  return { raw, prefix: `umk_${prefix}`, hash: hashApiKey(raw) };
}

// SHA-256 (not bcrypt) is deliberate: the key already has 256 bits of entropy, so brute force
// is infeasible; slow hashes only help for low-entropy human passwords and would add latency
// to every single MCP request.
export function hashApiKey(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

// Cheap shape check BEFORE touching the DB, so garbage input never causes a query.
export function looksLikeApiKey(raw) {
  return typeof raw === 'string' && raw.length <= 80 && KEY_RE.test(raw);
}

export function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Extract key from "Authorization: Bearer <key>" (also accepts x-api-key for simple clients).
export function extractKey(headers) {
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (m) return m[1];
  }
  const x = headers['x-api-key'];
  return typeof x === 'string' ? x : null;
}
