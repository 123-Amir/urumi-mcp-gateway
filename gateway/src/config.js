// All configuration comes from environment variables (Kubernetes Secret / ConfigMap in the cluster).
// Nothing secret has a default value: a missing secret must stop the process, not silently weaken it.
import { parseMasterKey } from './security/secretbox.js';

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const list = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const cookieSecure = bool(env.COOKIE_SECURE, prod); // production => Secure by default
  const cfg = {
    prod,
    port: int(env.PORT, 8080),
    dbPath: env.DB_PATH ?? './data/gateway.db',
    encryptionKey: parseMasterKey(env.GATEWAY_ENCRYPTION_KEY), // throws if missing/short
    bootstrap: { email: env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@example.com', apiKey: env.BOOTSTRAP_ADMIN_API_KEY ?? null },
    // Exact origins (scheme://host[:port]) the dashboard is served from. Used for CSRF origin checks + /mcp Origin check.
    allowedOrigins: list(env.PUBLIC_ORIGINS),
    mcpAllowedOrigins: list(env.MCP_ALLOWED_ORIGINS ?? env.PUBLIC_ORIGINS),
    cookie: {
      secure: cookieSecure,
      sameSite: env.COOKIE_SAMESITE ?? 'Strict', // dashboard + API share one host via Ingress, so Strict is safe
      // "__Host-" prefix makes browsers refuse the cookie unless Secure + Path=/ + no Domain attr.
      name: cookieSecure ? '__Host-umk_session' : 'umk_session',
    },
    sessionTtlMs: int(env.SESSION_TTL_MINUTES, 480) * 60_000,   // absolute lifetime
    sessionIdleMs: int(env.SESSION_IDLE_MINUTES, 60) * 60_000,  // inactivity timeout
    trustProxy: int(env.TRUST_PROXY_HOPS, 0),                    // 1 behind a single ingress
    loginRateLimit: { max: int(env.LOGIN_MAX_FAILURES, 10), windowMs: int(env.LOGIN_WINDOW_SECONDS, 60) * 1000 },
    upstream: { allowlist: list(env.UPSTREAM_ALLOWED_HOSTS), allowPrivate: bool(env.ALLOW_PRIVATE_UPSTREAMS, false) },
    timeouts: {
      connectMs: int(env.UPSTREAM_CONNECT_TIMEOUT_MS, 5000),
      listMs: int(env.UPSTREAM_LIST_TIMEOUT_MS, 8000),
      callMs: int(env.UPSTREAM_CALL_TIMEOUT_MS, 30000),
      refreshMs: int(env.UPSTREAM_REFRESH_MS, 30000),
      cooldownMs: int(env.UPSTREAM_RETRY_COOLDOWN_MS, 5000),
    },
    maxResultBytes: int(env.MAX_TOOL_RESULT_BYTES, 256 * 1024),
    maxArgBytes: int(env.MAX_TOOL_ARG_BYTES, 256 * 1024),
    seedServers: env.SEED_SERVERS_JSON ? JSON.parse(env.SEED_SERVERS_JSON) : [],
    logLevel: env.LOG_LEVEL ?? 'info',
  };
  if (prod) {
    if (!cfg.allowedOrigins.length) throw new Error('PUBLIC_ORIGINS is required in production');
    if (!cfg.cookie.secure) throw new Error('COOKIE_SECURE must be true in production');
  }
  return cfg;
}
