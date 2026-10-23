# Threat model

Scope: the gateway, its upstream MCP servers, the dashboard and chat agent, and the Kubernetes deployment. "Verified" means an automated test in this repo exercises it; "design only" means it relies on configuration I could not run here (see the status box in the README).

## Assets and actors
**Assets:** upstream credentials (e.g. the WooCommerce REST key held by woo-mcp's token and the gateway's stored tokens), user API keys, store data (orders, customer details), the audit log, the LLM API key.
**Actors:** admin (manages servers and members), member (uses tools), an MCP server author (an upstream the admin registered), an external attacker (internet), a compromised pod/container.

## 1. Shared upstream credentials: what can a member do with a credential they never see?
Members cannot read, extract or redirect a credential:
* Not returned by any API: the server view exposes only `hasCredential: true/false` (`gateway/src/http/serializers.js`, whitelist-based so a new column stays private by default). (test: gateway/test/auth.test.js → "API responses never contain key hashes, upstream credentials")
* Encrypted at rest with AES-256-GCM; the key comes from a Kubernetes Secret, not the database. A stolen database file or volume snapshot is not enough. (test: gateway/test/security.test.js → "secretbox: roundtrip, random iv, tamper")
* Attached only to requests to the URL the admin registered; members cannot change that URL. (test: gateway/test/gateway.test.js → "upstream credential is attached by the gateway")
* Never logged: the logger drops sensitive field names and masks key patterns. (test: gateway/test/auth.test.js → "login with bootstrap admin key")

**What a member *can* do is use the credential's authority, indirectly, through the tools they are allowed to call.** The gateway acts as a confused deputy by design: if `woo__update_order_status` is allowed, the member can change order statuses with the store key's privileges. Controls: per-user and per-role deny rules (hidden from the tool list *and* rejected if called; admins are exempt) (test: gateway/test/gateway.test.js → "per-user tool filtering"); woo-mcp validates every argument and returns a trimmed, PII-free shape; every call is audited under the member's name. Residual risk: the WooCommerce key is `read_write` (needed for create/update), and there is no UI for tool rules yet.

**An admin cannot read a credential either, but could once have *steered* it.** While writing this document I found that editing a server's URL kept the stored credential, so an admin (or a hijacked admin session) could point `woo` at a host they control and receive the token. **Fixed:** changing the URL of a server that has a stored credential now requires entering the credential again; the attacker host receives no request at all. (test: gateway/test/gateway.test.js → "credential exfiltration") Remaining gap: an attacker who controls DNS for the *registered hostname* is outside what the gateway can detect.

## 2. Why client tokens are not passed through to upstream servers
The user's gateway key authenticates a person *to the gateway*. If the gateway forwarded it, every upstream (including a third-party one) would receive a long-lived credential valid against the gateway, could replay it to act as that user on every other server, and could not tell who the token was meant for (no audience binding). That is the "token passthrough" confused-deputy pattern the MCP authorization guidance warns against. Instead the gateway authenticates to each upstream with **that server's own credential**, and the upstream never learns who the end user is (identity lives in the gateway's audit log). (test: gateway/test/gateway.test.js → "the caller's gateway key is NEVER forwarded"; e2e step "gateway process logs contain no API keys or upstream tokens")
Trade-off: upstreams cannot apply per-user permissions themselves; all per-user policy must live in the gateway.

## 3. Untrusted upstreams: tool descriptions written to manipulate the model
An upstream is third-party text that reaches the model. Mitigations in place:
* Tool descriptions are capped at 600 characters, control characters stripped, each prefixed with `[server-slug]` so humans and the model can see who wrote it; tool names must match `^[A-Za-z0-9_-]{1,32}$`; input schemas over 16 KB are dropped; at most 200 tools per server. (test: gateway/test/gateway.test.js → "hostile upstream output is bounded")
* The chat system prompt states that tool descriptions and results are untrusted data and must not be obeyed; tool results go in `tool` messages, never `system` or `user`; the browser cannot send `system`/`tool` messages at all. (test: gateway/test/chat.test.js → "prompt-injection hygiene"; "client cannot forge system/tool messages")
* The model only sees tools the *current user* may call, and a tool call is re-authorized when executed. Step/call/size/time caps bound a runaway loop. (test: gateway/test/chat.test.js → "max-steps cap")
* Result size is capped (256 KB); calls and connects have timeouts; redirects are not followed; malformed responses mark the server unreachable. (tests: "SLOW upstream", "HANGING upstream", "MALFORMED upstream and REDIRECTING upstream" in gateway/test/gateway.test.js)

**What an admin-registered malicious server can still do (residual, not solved):**
1. **Prompt injection works in principle.** The tests prove the loop treats injected text as data; they cannot prove a real LLM will ignore it. A poisoned description or result could steer the model to call *other* tools the same user is allowed to use (including write tools). There is no human-confirmation step before write tools.
2. **It sees the arguments** of every call routed to it, and results flow to the LLM provider.
3. It can lie in results.
Mitigations an operator should apply: register only servers you trust, deny write tools for members, review tool lists after upstream changes, and add confirmation for destructive tools (not implemented).
**If an admin registers a malicious URL:** the SSRF guard blocks cloud-metadata and link-local addresses unconditionally, blocks private/loopback addresses unless on the explicit allowlist (exact hostnames, not a wildcard, so WordPress and MariaDB are not registrable), checks every DNS answer, and re-checks on every connect. (tests: gateway/test/security.test.js → "ssrf:"; gateway/test/gateway.test.js → "SSRF: metadata, private-not-allowlisted") Known limit: DNS rebinding between check and connect is narrowed, not eliminated; the NetworkPolicy egress rule (private ranges and 169.254.0.0/16 excluded) is the second layer and is **design only until run on a cluster that enforces policy**.

## 4. What one team member can do to another
| Action | Possible? | Why |
|---|---|---|
| See or use another member's API key | No | keys are hashed; shown once; `GET /api/keys?userId=` is 403 for others (test: gateway/test/auth.test.js → "member can only see/manage own keys") |
| Revoke another member's key | No (404, so ids cannot be enumerated) | same test |
| Read another member's audit log | No | member queries are forced to their own user id |
| Read another member's chat | No | conversations are not stored server-side |
| Use the gateway as another member | No | the audit/identity comes from the authenticated key or session |
| Escalate to admin | No | role read from the database per request; admin routes return 403 (test: gateway/test/auth.test.js → "role restrictions") |
| Read the same store data | **Yes** | all members share the store's credential; there is no per-member data isolation inside WooCommerce |
| Degrade service for others | **Partly** | chat is rate-limited per user (20/min) and login failures per IP; **tool calls over `/mcp` are not rate-limited**, so one member can generate heavy load |
| Hide their activity | No | every tool call is audited with their identity |

## 5. Other threats
| Threat | Control | Status |
|---|---|---|
| Stolen API key | revoke (kills sessions too), `last used` shown; **keys do not expire** | revocation verified; expiry not implemented |
| CSRF on the dashboard | SameSite=Strict, CSRF token, Origin check, `/mcp` ignores cookies | verified (auth.test.js) |
| XSS in the dashboard | React escaping; no `dangerouslySetInnerHTML`/storage APIs (enforced by a static test); CSP `script-src 'self'`; **if XSS happened the attacker could still act as the user** | partly verified; CSP header is in the nginx image, not browser-tested |
| Session fixation / replay | new token per login; server-side logout and expiry | verified |
| Brute force | 256-bit keys; login limiter (10 failures/min/IP, in-memory) | verified |
| Database or volume leak | hashed keys, hashed session tokens, encrypted upstream credentials; **loss of the encryption key makes stored credentials unrecoverable** (back it up) | verified (unit) |
| SQL injection | prepared statements only; key shape validated before queries | verified |
| Prompt/LLM data exposure | tool results are sent to the LLM provider; WooCommerce customer PII is stripped in woo-mcp before it can reach any client | PII stripping verified |
| Pod compromise / lateral movement | non-root, read-only root fs, all capabilities dropped (WordPress/MariaDB exceptions documented), no service-account token and no RBAC for any pod, default-deny NetworkPolicies | rendered and checked statically; **enforcement not run** |
| WordPress attack surface | public wp-admin and plugins are the store's normal exposure; WordPress is root-started with 6 capabilities | design only |
| Supply chain | npm lockfiles with `npm ci`; third-party image tags float | partly mitigated |
| Direct access to an upstream | woo-mcp/demo servers need their bearer token and are ClusterIP-only with NetworkPolicy; direct call without the token is 401 (e2e) | token verified; network isolation not run |
