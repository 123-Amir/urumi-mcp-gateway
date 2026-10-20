# Requirement → implementation → evidence checklist
Status legend: ✅ done + tested | 🟡 code written, not yet verified end-to-end | ⬜ not started | 🚫 blocked (reason)

| # | Requirement | Implementation | Evidence | Status |
|---|-------------|----------------|----------|--------|
| 1 | API keys: CSPRNG, hashed, revocable | gateway/src/security/apikeys.js, db/database.js | test/security.test.js, test/db.test.js | ✅ |
| 2 | Upstream creds encrypted at rest | security/secretbox.js | secretbox test (tamper/wrong key) | ✅ |
| 3 | SSRF guard for admin URLs | security/ssrf.js | 6 ssrf tests | ✅ (rebinding TOCTOU = documented limit) |
| 4 | Roles admin/member, users, servers, audit tables | db/database.js | db.test.js | ✅ |
| 5 | Dashboard login (key-paste → HttpOnly session), CSRF, expiry, logout, revocation, RBAC on every route | routes/*.js, http/middleware.js | test/auth.test.js (16 tests) | ✅ (HTTP level; browser UI ⬜) |
| 6 | Gateway MCP endpoint (aggregate, route, `slug__tool` namespacing, per-user filtering, audit) | gateway/{mcpEndpoint,service,upstreams}.js | test/gateway.test.js (real SDK client + 6 fake upstreams) | ✅ (against fake upstreams; real Woo ⬜) |
| 7 | Timeouts / dead-upstream isolation / status tracking | gateway/upstreams.js | slow, dead, hanging, malformed, redirect, die-then-recover tests | ✅ (fake upstreams; real pod-kill on k8s ⬜ 🚫) |
| 8 | Woo MCP server (5 tools, Streamable HTTP, bearer-protected, PII-minimised) | woo-mcp/src/*.js | woo-mcp/test (9) vs FAKE WooCommerce REST | 🟡 real WooCommerce ⬜ (needs cluster) |
| 9 | 2 extra upstream servers (own demo servers: utils, notes) | demo-mcp/src/*.js | demo-mcp/test (3) + gateway/test/real-upstreams.test.js (4) | ✅ |
| 10 | React dashboard | — | — | ⬜ |
| 11 | Chat agent tool loop (+ mock mode) | — | — | ⬜ |
| 12 | Helm charts (local + prod values), probes, limits, NetworkPolicy | — | — | ⬜ |
| 13 | Cluster run (kind/k3d) | — | 🚫 no docker/kubectl/helm in authoring sandbox | 🚫 |
| 14 | E2E scenarios 1–10 | — | — | ⬜ |

## Known limitations (honest list)
- SQLite on one PVC => single gateway replica (multi-replica needs Postgres + shared rate-limit store).
- /mcp is stateless: no tools/list_changed push, no GET/SSE stream; clients re-list tools.
- Tool calls are never auto-retried (could duplicate side effects); a call during a dying upstream returns an error.
- Login rate limit is in-memory per process.
- SSRF: DNS-rebinding TOCTOU narrowed (re-check on each connect) but not eliminated; NetworkPolicy egress is the 2nd layer (unverified, needs a cluster).
- A secret placed in an upstream URL *query string* is not treated as a credential and is shown to admins.
- Tool descriptions from upstreams are untrusted; we cap/sanitize + attribute them, but cannot stop prompt-injection by content alone.
