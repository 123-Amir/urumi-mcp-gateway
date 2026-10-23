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
| 12 | Helm charts (local+prod values), Dockerfiles, probes, requests/limits, Secrets, PVCs, Ingress, security contexts, NetworkPolicies, least-privilege SAs | charts/urumi/**, */Dockerfile, dashboard/nginx.conf, scripts/*.sh, docs/DEPLOYMENT.md | scripts/verify-chart.sh: stand-in render + kubeconform strict (37 local / 36 prod valid) + 247/221 policy checks + 22/22 mutation faults caught; image contexts boot as uid 10001 on read-only tree | 🟡 statically verified only; **never rendered by real helm, never built by docker, never run on a cluster** |
| 13 | Cluster run (kind/k3d) + NetworkPolicy enforcement + pod-kill | scripts/kind-up.sh, install-local.sh, smoke.sh | smoke.sh written, not executed | 🚫 no docker/kubectl/helm in authoring sandbox: run on your machine |
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
- Deploy: WordPress/Apache runs as root with caps dropped to six (documented exception); MariaDB/WordPress keep a writable root fs. wp-cli sidecar needs outbound HTTPS to wordpress.org to install WooCommerce (set `store.installWooCommerce=false` and preinstall to go air-gapped).
- Deploy: woo-mcp talks plain HTTP to the WordPress Service and sends `X-Forwarded-Proto: https`; wp-config trusts that header (NetworkPolicy limits who can send it). Unverified against a real WooCommerce: fallback is OAuth1 signing or HTTPS via the Ingress.
- Deploy: gateway is a single replica (SQLite on RWO PVC); WordPress/gateway upgrades use `Recreate` (short outage); rollback does not roll back data; `local-path` storage is node-local (no HA, back up volumes).
- Deploy: floating third-party tags (`wordpress:6-apache`, `mariadb:11`) for convenience; pin by digest in production.

## Required end-to-end scenarios (assignment "Definition of done")
Evidence: `node e2e/run.mjs` (writes `docs/E2E_LAST_RUN.md`) = real gateway/woo-mcp/demo-mcp **processes** + official MCP SDK client + dashboard-style cookie/CSRF session. WooCommerce is a **fake** and chat is **mock mode**.
`bash e2e/sabotage.sh` proves the e2e can fail (5 injected gateway bugs, all detected).

| # | Scenario | What is proven | Still NOT proven (needs your cluster / real services) |
|---|---|---|---|
| 1 | Storefront: cart, checkout (COD), order in WooCommerce admin | order created via fake checkout is readable through the gateway (SIMULATED) | real WordPress/WooCommerce storefront + wp-admin UI |
| 2 | User A: chat creates a product; appears on storefront | chat tool loop -> gateway -> woo-mcp -> (fake) store, audited as A; product on fake storefront | real LLM; real storefront |
| 3 | Order placed; chat answers "orders today" | two-tool chain (date -> list_orders) returns the order; PII not leaked | real LLM; real order via real checkout; real WooCommerce `after` filter timezone semantics |
| 4 | User B: external client with only URL + key | official SDK client connects with Bearer key only | Claude Code / Cursor / MCP Inspector specifically |
| 5 | B discovers tools of all enabled upstreams and asks the orders question | 10 tools from 3 servers; tool-level orders query works | natural-language prompt through a real LLM |
| 6 | One prompt needing two upstreams | chat trace shows utils + woo | real LLM choosing tools itself |
| 7 | Revoke B's key; next call rejected | live client, fresh connection and dashboard login all rejected | - |
| 8 | Disable an upstream; tools vanish from chat and external client | list + chat tool list + direct call + chat reply; re-enable restores | - |
| 9 | Kill one upstream; others work; dashboard shows unreachable | real process SIGKILL; clear error; other upstreams OK; status+reason; auto-reconnect after restart | real `kubectl delete pod` |
| 10 | All calls in audit under the right user | multiset comparison of 12 calls vs audit rows; no args/secrets stored; logs secret-free | - |

## Assignment deliverables checklist
| Deliverable (from the assignment) | Where | Status |
|---|---|---|
| README: local setup, VPS setup, place an order, connect an external MCP client, use the chat agent | `README.md`, `docs/DEPLOYMENT.md` | written; cluster steps **not run** |
| Source: dashboard, backend + gateway, WooCommerce MCP server, chat agent | `dashboard/`, `gateway/`, `woo-mcp/`, `gateway/src/chat/` | done, tested |
| Helm charts and values (local + prod) | `charts/urumi/` | statically verified; **not installed** |
| "System design and tradeoffs" note | `docs/SYSTEM_DESIGN.md` | done |
| Threat model note (shared credentials, no token passthrough, untrusted upstreams, member vs member) | `docs/THREAT_MODEL.md` | done |
| Bonus / stand-out list and where to find them | `README.md` (Bonus and stand-out items) | done |
| Demo video | script: `docs/DEMO_SCRIPT.md` | **video not recorded** (needs your cluster) |
| Manager interview prep (Hinglish) | `docs/INTERVIEW_PREP_HINGLISH.md` | done; every citation machine-checked |
| Documentation is consistent with the code | `docs/check_docs.py` (`make docs-check`), `docs/test_check_docs.py` | 95 paths, 56 test citations, 11 code excerpts, 22 env vars, 20 numeric facts verified |

## Security findings fixed during documentation
* Editing a server's URL kept its stored credential, so an admin could have redirected it to a host they control. Now the credential must be re-entered when the URL changes (test: `gateway/test/gateway.test.js`, "credential exfiltration").
