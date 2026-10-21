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
| 10 | React dashboard: login, servers (status/tools/add/edit/disable/remove), team + keys (one-time key), audit log, chat with tool receipts | dashboard/src/** | dashboard/test (25: static security guards, API client, component flows) + gateway/test/dashboard-contract.test.js (real api.js vs real gateway) | 🟡 behaviour verified in jsdom + against real gateway; **never opened in a real browser** (no browser in sandbox): layout, responsiveness, dark mode, keyboard flow need manual check |
| 11 | Chat agent: real tool loop via gateway AS the user, OpenAI-compatible provider (configurable), labelled mock mode, caps, rate limit, mid-chat revocation | gateway/src/chat/*.js, routes/chat.js | gateway/test/chat.test.js (12): scripted loop, fake OpenAI-compatible server, mock e2e | 🟡 loop + wire format verified; **real OpenAI/LLM NOT tested** (no key; api.openai.com unreachable from sandbox); chat UI ⬜ |
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
- Chat: conversations are not stored server-side (kept in the browser); no streaming (single JSON response); tool calls within one step run sequentially.
- Chat: prompt-injection via tool output is mitigated structurally (untrusted-data rule, `tool` role, per-user tool filtering, step/call caps) but NOT provably prevented; no human-confirmation step before write tools yet.
- Dashboard: no UI yet for tool deny-rules (backend + tests exist: /api/policies). Chat has no streaming. No pagination count (Older/Newer only). Not visually reviewed in a browser.
- Dashboard: CSRF token lives in JS memory, so a same-origin XSS could still act as the user (React escaping, no dangerouslySetInnerHTML/localStorage are enforced by tests; a strict CSP header must be set by the Ingress/nginx in Phase 7).
