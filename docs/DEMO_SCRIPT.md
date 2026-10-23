# Demo video script (about 18 minutes)

Rules for the recording: say plainly what is real and what is simulated. In this repository's authoring environment there was no cluster, so **every Kubernetes step below must be rehearsed on your machine first**; the commands are correct as far as static checks go, but they have not been run. If a step fails on camera, say so and show the log: that is better than hiding it.

## Pre-flight (before you press record)
```bash
scripts/kind-up.sh && scripts/build-images.sh && scripts/install-local.sh && scripts/smoke.sh
kubectl -n urumi get pods                                   # everything Running/Ready (first start takes minutes)
kubectl -n urumi logs deploy/urumi-wordpress -c wp-setup | tail -3     # expect "[wp-setup] ready"
export ADMIN_KEY=$(kubectl -n urumi get secret urumi-secrets -o jsonpath='{.data.BOOTSTRAP_ADMIN_API_KEY}' | base64 -d)
```
Optional real LLM: install with `--set gateway.llm.provider=openai --set gateway.llm.model=<model>` and put your key in the Secret (`OPENAI_API_KEY`). **If you do not, the chat is in mock mode: say so on camera.** Have ready: two browser profiles (Alice, Bob), MCP Inspector (`npx @modelcontextprotocol/inspector`), a terminal with `kubectl`.

## Part 1: System design (2 min)
Show the diagram in `README.md`. Say: store on Kubernetes; woo-mcp is my own server; the gateway is an MCP client to every upstream **and** an MCP server to everyone else; the dashboard and chat agent are just two more clients of the same code path; nothing but the gateway talks to an upstream. Point at `GatewayService.callTool` (`gateway/src/gateway/service.js`): policy and audit live there, for chat and external clients alike.

## Part 2: Kubernetes (3 min)
```bash
kubectl -n urumi get deploy,sts,svc,pvc,ingress
kubectl -n urumi get networkpolicy
kubectl -n urumi get secret                                  # names only: never print values on camera
kubectl -n urumi get deploy urumi-gateway -o yaml | grep -A12 -E "resources:|livenessProbe|readinessProbe|securityContext"
```
Say: two public hosts; woo-mcp, MariaDB and the demo servers are ClusterIP with no Ingress; NetworkPolicy is default-deny with explicit edges (gateway -> upstreams, woo-mcp -> WordPress -> MariaDB). Show enforcement:
```bash
scripts/smoke.sh        # includes "unrelated pod cannot reach woo-mcp / mariadb" and "gateway CAN reach woo-mcp"
```
Say honestly: policies only work because kind runs Calico here; kind's default network plugin would ignore them. Persistence: `kubectl -n urumi delete pod -l app.kubernetes.io/component=wordpress` and show the store comes back with its products (PVC).

## Part 3: The definition-of-done flow, two users (7 min)
1. **Admin**: open `http://dashboard.localtest.me`, sign in with `$ADMIN_KEY`. *Servers*: woo (first), utils, notes all **Connected**; expand woo to show `woo__list_orders` etc. (the `server__tool` naming and why it is always prefixed). **Team > Invite member**: create Alice and Bob; copy their one-time keys (say: shown once, only the hash is stored).
2. **Alice** (profile 1, signs in with her key): *Chat*: "Create a product called Blue Mug priced 199". Show the **tool receipt** (`woo__create_product`, arguments, result, ms). Open `http://shop.localtest.me`: the product is on the storefront. *(Real WooCommerce, if the cluster is up.)*
3. **Place an order by hand** on the storefront: add to cart, checkout, *Cash on delivery*. Open `/wp-admin` > WooCommerce > Orders (admin password from the Secret) and show the order.
4. **Alice**: Chat: "what orders came in today?". Show two receipts (`utils__current_date`, then `woo__list_orders`): two different upstreams in one prompt. Say: with the mock provider this is scripted; with a real model the model chooses the tools; the loop, gateway call and audit are the same code.
5. **Bob** (MCP Inspector): transport *Streamable HTTP*, URL `http://dashboard.localtest.me/mcp`, header `Authorization: Bearer <Bob's key>` and nothing else. List tools (all three servers). Call `utils__current_date`, then `woo__list_orders` with `created_today: true`. For a natural-language prompt that needs two servers, use Claude Code/Cursor with Bob's key if you have a model; otherwise say the Inspector run is tool-level.
6. **Revoke Bob's key** (Admin > Team > Bob > Keys > Revoke). In Inspector, call a tool again: **401**. Also try signing in as Bob in the dashboard: rejected.
7. **Disable `utils`** (Servers > Disable). In Alice's chat: "what is the date?": the assistant says the tool is not available; in the Inspector (use Alice's key) the `utils__*` tools are gone. Re-enable.
8. **Kill an upstream**:
   ```bash
   kubectl -n urumi scale deploy/urumi-demo-notes --replicas=0       # stable "dead" state for the demo
   ```
   Servers page: **notes Unreachable** with a reason (press *Check now*, or wait up to 30 s); woo and utils still work (run a tool). Then `kubectl -n urumi scale deploy/urumi-demo-notes --replicas=1`: it reconnects by itself. (Also `kubectl delete pod -l app.kubernetes.io/component=demo-notes` to show the Deployment self-heals; the gap is only a few seconds.)
9. **Audit log**: show every call above under Alice, Bob or the admin, with server, tool, duration, outcome and the failed ones with a safe summary. Say: arguments and results are deliberately not stored.

## Part 4: MCP internals (2 min)
Show the sequence diagram in `docs/SYSTEM_DESIGN.md`. Say: initialize + `tools/list` are answered from the gateway's cached, sanitised tool list (never waits on an upstream); `tools/call` splits `woo__list_orders` at the first `__`, applies the user's deny-rules, uses **the server's own** stored token (the user's key is never forwarded), enforces timeouts and a size cap, and writes the audit row. Collisions: always-prefixed names. Failure isolation: run `make e2e` live (no cluster needed) and point at scenarios 8 and 9; run `make e2e-sabotage` if time allows to show the e2e can fail.

## Part 5: Security posture (2 min)
* Keys: 256-bit random, SHA-256 only in the database, shown once; revocation is immediate (e2e scenario 7). Upstream credentials: AES-256-GCM, key from a Secret, never in any API response (`gateway/test/auth.test.js`).
* Member vs admin: in Alice's session call `/api/servers` -> 403 (`curl` with her cookie or the dashboard shows no Servers page; the server is what enforces it).
* Malicious server: try adding `http://169.254.169.254/` in the dashboard -> rejected (SSRF). Then discuss `docs/THREAT_MODEL.md`: a registered-but-malicious server can still attempt prompt injection and sees the arguments sent to it; mitigations and honest limits are written down. Mention the fix you found: changing a server's URL now requires re-entering the credential.

## Part 6: Chat agent (1.5 min)
Open `gateway/src/chat/agent.js`: model -> tool calls -> `service.callTool` as the logged-in user -> results back -> repeat; limits (6 steps, 4 calls per step, 120 s); identity re-checked before each tool; the browser cannot inject `system`/`tool` messages. Say again whether this run used the mock or a real model.

## Part 7: Local to VPS (2 min)
Show the table in `docs/DEPLOYMENT.md` (domain, scheme/cookies, ingress class, storage class, Secret strategy, LLM). Same chart, two values files. Show:
```bash
helm history urumi -n urumi
helm upgrade urumi charts/urumi -n urumi -f charts/urumi/values-local.yaml --atomic --timeout 15m
helm rollback urumi 1 -n urumi --wait
```
Say clearly if you did **not** deploy to a VPS: "the production values are rendered and validated statically; I did not deploy them".

## What to state as limitations (do not skip)
Single gateway replica (SQLite); `/mcp` calls are not rate-limited; no key expiry; no human confirmation before write tools; chat mock unless a model is configured; tool rules have no UI; WordPress runs as root with reduced capabilities; multi-store provisioning, OAuth and metrics were not attempted.
