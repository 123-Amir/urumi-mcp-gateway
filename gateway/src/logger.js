// Structured JSON logs. Defense in depth: even if a developer accidentally logs a secret,
// (1) fields with sensitive names are dropped and (2) key/bearer patterns inside strings are masked.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /authorization|cookie|credential|api[-_]?key|token|secret|password|csrf/i;
export const scrub = (s) => String(s)
  .replace(/umk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{20,}/g, 'umk_[REDACTED]')
  .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{6,}/gi, 'Bearer [REDACTED]');

export function createLogger({ level = 'info', sink = (line) => process.stdout.write(line + '\n') } = {}) {
  const min = LEVELS[level] ?? 20;
  const emit = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    const safe = {};
    for (const [k, v] of Object.entries(fields)) {
      if (SENSITIVE_KEY.test(k)) continue;
      safe[k] = typeof v === 'string' ? scrub(v) : v instanceof Error ? scrub(v.message) : v;
    }
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...safe }));
  };
  return { debug: (m, f) => emit('debug', m, f), info: (m, f) => emit('info', m, f), warn: (m, f) => emit('warn', m, f), error: (m, f) => emit('error', m, f) };
}
