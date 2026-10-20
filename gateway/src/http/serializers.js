// The ONLY place DB rows are turned into API output. Whitelisting fields here (instead of "delete the secret
// fields") means a new sensitive column added later is private by default.
export const serializeUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.created_at });
export const serializeKey = (k) => ({ id: k.id, userId: k.user_id, label: k.label, prefix: k.prefix,
  createdAt: k.created_at, lastUsedAt: k.last_used_at, revokedAt: k.revoked_at });
export const serializeServer = (s, live = {}) => ({
  id: s.id, slug: s.slug, name: s.name, url: s.url, enabled: !!s.enabled,
  authType: s.auth_type, authHeaderName: s.auth_header_name,
  hasCredential: !!s.credential_enc,           // boolean only: the value (even encrypted) never leaves the server
  createdAt: s.created_at, updatedAt: s.updated_at,
  status: live.status ?? (s.enabled ? 'connecting' : 'disabled'), statusDetail: live.error ?? null,
  lastCheckedAt: live.lastCheckedAt ?? null, tools: live.tools ?? [],
});
export const serializeAudit = (a) => ({ id: a.id, timestamp: a.ts, userId: a.user_id, userEmail: a.user_email, source: a.source,
  server: a.server_slug, tool: a.tool, durationMs: a.duration_ms, success: !!a.success, errorSummary: a.error_summary });
