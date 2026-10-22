# Last end-to-end run (`node e2e/run.mjs`)

Run at 2026-10-22T18:16:38.506Z. Real gateway/woo-mcp/demo-mcp processes + official MCP SDK client; **WooCommerce is a fake** and chat is **mock mode** (no LLM).

**37 PASS, 2 SIMULATED, 2 NOT RUN, 0 FAIL**

| Scenario | Check | Status | Evidence |
|---|---|---|---|
| Setup: first admin signs in with the bootstrap key; WooCommerce MCP server is pre-registered | first registered server is the WooCommerce MCP server | PASS | woo,utils,notes |
| Setup: first admin signs in with the bootstrap key; WooCommerce MCP server is pre-registered | all three upstreams Connected | PASS | woo:connected utils:connected notes:connected |
| Setup: first admin signs in with the bootstrap key; WooCommerce MCP server is pre-registered | user A and user B exist with individual keys | PASS |  |
| 1. Store: shopper checks out; order is visible to the admin  (SIMULATED store: NOT real WooCommerce) | order placed via the (fake) checkout is readable through the gateway | SIMULATED | order #1001 299.00 INR |
| 1. Store: shopper checks out; order is visible to the admin  (SIMULATED store: NOT real WooCommerce) | real storefront + WooCommerce admin UI | NOT RUN | needs the real cluster: not exercised here |
| 2. As user A: chat agent creates a product; it appears on the storefront | chat called woo__create_product as user A | PASS | 15 ms |
| 2. As user A: chat agent creates a product; it appears on the storefront | product appears on the (fake) storefront with the right price | SIMULATED | {"name":"Blue Bottle","price":"499"} |
| 2. As user A: chat agent creates a product; it appears on the storefront | reply is labelled as mock mode | PASS |  |
| 3. A shopper buys it; user A asks the chat agent for today's orders | chat used two tools in order: utils__current_date then woo__list_orders | PASS |  |
| 3. A shopper buys it; user A asks the chat agent for today's orders | answer includes the new order (2 x 499 = 998.00) | PASS | - woo__list_orders: 2 order(s) today: #1002 processing 998.00 INR; #1001 processing 299.00 INR |
| 3. A shopper buys it; user A asks the chat agent for today's orders | customer PII (email/phone) never reaches the chat/tool output | PASS |  |
| 4+5. User B connects an external MCP client with ONLY the gateway URL and B's key | B discovers tools from ALL enabled upstreams (10 tools, 3 servers) | PASS | 10 tools |
| 4+5. User B connects an external MCP client with ONLY the gateway URL and B's key | B answers the same "orders today" question (tool level) and sees the order | PASS | date 2026-10-22, 2 order(s) |
| 4+5. User B connects an external MCP client with ONLY the gateway URL and B's key | B has no LLM here: the natural-language prompt part is NOT run | NOT RUN | a real client (Claude Code/Cursor) + real LLM needed |
| 6. One prompt that needs tools from two different upstream servers | the "orders today" prompt touched two upstreams (utils + woo) | PASS | utils+woo |
| 7. Revoke user B's key: the next request is rejected | admin revokes B's key | PASS |  |
| 7. Revoke user B's key: the next request is rejected | B's already-connected client is rejected on its next request | PASS |  |
| 7. Revoke user B's key: the next request is rejected | a brand-new connection with B's key is rejected too | PASS |  |
| 7. Revoke user B's key: the next request is rejected | B cannot sign in to the dashboard with the revoked key | PASS |  |
| 8. Disable an upstream: its tools disappear from the chat agent AND the external client | baseline: A (external client + chat tool list) sees utils tools | PASS |  |
| 8. Disable an upstream: its tools disappear from the chat agent AND the external client | external client no longer lists utils__* tools | PASS | 8 tools left |
| 8. Disable an upstream: its tools disappear from the chat agent AND the external client | chat agent's tool list no longer has utils__* tools | PASS |  |
| 8. Disable an upstream: its tools disappear from the chat agent AND the external client | chat can no longer use the date tool (no tool call made, told it is unavailable) | PASS |  |
| 8. Disable an upstream: its tools disappear from the chat agent AND the external client | calling the disabled tool directly is rejected | PASS |  |
| 8. Disable an upstream: its tools disappear from the chat agent AND the external client | re-enabling brings the tools back | PASS |  |
| 9. Kill one upstream process: the others keep working; dashboard shows it unreachable | call to the dead upstream returns a clear error (no hang) | PASS | [gateway] Upstream "notes" is unreachable (connection: ECONNREFUSED) |
| 9. Kill one upstream process: the others keep working; dashboard shows it unreachable | woo and utils still work while notes is down | PASS |  |
| 9. Kill one upstream process: the others keep working; dashboard shows it unreachable | dashboard API reports notes as unreachable, with a reason | PASS | connection: ECONNREFUSED |
| 9. Kill one upstream process: the others keep working; dashboard shows it unreachable | notes tools are hidden while it is down | PASS |  |
| 9. Kill one upstream process: the others keep working; dashboard shows it unreachable | after the process restarts, the gateway reconnects by itself (background refresh) | PASS |  |
| 9. Kill one upstream process: the others keep working; dashboard shows it unreachable | notes tools work again | PASS |  |
| Extra: security properties asserted on the live system | woo-mcp cannot be used directly without its token (needs the gateway-held credential) | PASS |  |
| Extra: security properties asserted on the live system | member A is refused admin APIs (403) | PASS |  |
| Extra: security properties asserted on the live system | SSRF: registering the cloud-metadata address is refused | PASS |  |
| Extra: security properties asserted on the live system | no upstream credential/token appears in the admin servers API | PASS |  |
| Extra: security properties asserted on the live system | BONUS tool permissions: member A loses create_product (hidden + rejected); admin keeps it | PASS |  |
| 10. Every tool call is in the audit log under the right user | all 12 calls made in this run appear in the audit log, per user + source + server + tool | PASS | 12 rows |
| 10. Every tool call is in the audit log under the right user | rows are attributed to the right users | PASS | bob=2 alice=9 admin=1 |
| 10. Every tool call is in the audit log under the right user | failed calls recorded as failures with a safe summary | PASS |  |
| 10. Every tool call is in the audit log under the right user | rows carry duration + timestamp; no arguments or secrets are stored | PASS |  |
| 10. Every tool call is in the audit log under the right user | gateway process logs contain no API keys or upstream tokens | PASS |  |
