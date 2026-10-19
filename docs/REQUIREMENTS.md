# Requirement → implementation → evidence checklist
Status legend: ✅ done + tested | 🟡 code written, not yet verified end-to-end | ⬜ not started | 🚫 blocked (reason)

| # | Requirement | Implementation | Evidence | Status |
|---|-------------|----------------|----------|--------|
| 1 | API keys: CSPRNG, hashed, revocable | gateway/src/security/apikeys.js, db/database.js | test/security.test.js, test/db.test.js | ✅ |
| 2 | Upstream creds encrypted at rest | security/secretbox.js | secretbox test (tamper/wrong key) | ✅ |
| 3 | SSRF guard for admin URLs | security/ssrf.js | 6 ssrf tests | ✅ (rebinding TOCTOU = documented limit) |
| 4 | Roles admin/member, users, servers, audit tables | db/database.js | db.test.js | ✅ (storage only; HTTP enforcement ⬜) |
| 5 | REST API w/ authz on every route | — | — | ⬜ |
| 6 | Gateway MCP endpoint (aggregate, route, namespacing) | — | — | ⬜ |
| 7 | Timeouts / dead-upstream isolation | — | — | ⬜ |
| 8 | Woo MCP server (5 tools, Streamable HTTP) | — | — | ⬜ |
| 9 | 2 extra upstream servers | — | — | ⬜ |
| 10 | React dashboard | — | — | ⬜ |
| 11 | Chat agent tool loop (+ mock mode) | — | — | ⬜ |
| 12 | Helm charts (local + prod values), probes, limits, NetworkPolicy | — | — | ⬜ |
| 13 | Cluster run (kind/k3d) | — | 🚫 no docker/kubectl/helm in authoring sandbox | 🚫 |
| 14 | E2E scenarios 1–10 | — | — | ⬜ |
