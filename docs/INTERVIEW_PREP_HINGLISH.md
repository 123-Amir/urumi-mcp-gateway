# Interview prep guide (Hinglish): Urumi MCP platform

Ye guide tumhare Round 2 (live walkthrough) aur manager ke sawaalon ke liye hai. Har answer ek hi pattern follow karta hai:

> **"Yahan maine [approach] isliye use kiya kyunki [is project ki problem]. Isse [fayda] milta hai. Agar hum [alternative / ise hata dete] to [nuksaan]. Is implementation ki limitation [limitation] hai."**

Aur har important claim ke saath ek **file** aur ek **test** ka naam hai, taaki tum code kholke dikha sako. Test ka format hai `(test: file → "title ka hissa")`; ek script (`docs/check_docs.py`) verify karti hai ki ye file aur title sach mein repo mein hain.

## 0. Teen sentence jo tumhe bina ruke bolne aane chahiye (honesty)
1. "Mera sab kuch ek sandbox mein bana jahan Node tha, lekin **Docker, Kubernetes aur real Helm nahi the**, isliye cluster par chalna, NetworkPolicy ka asli enforcement, aur real WooCommerce integration maine **khud verify nahi kiya**; wo mere laptop par karne wale hisse hain."
2. "Chat agent ka loop, gateway call aur audit real code hai aur tested hai, lekin **real LLM ke saath test nahi hua**; default mock mode hai jo har reply par khud ko mock likhta hai."
3. "109 automated tests aur ek end-to-end run (37 passing checks) real server processes par chalta hai, lekin WooCommerce us run mein **fake** hai."

Agar manager poochhe "kya ye production-ready hai?", jawab: "Core design aur security controls tested hain, lekin single replica hai, `/mcp` par rate limit nahi hai, key expiry nahi hai, aur cluster-side cheezein unverified hain; to 'production-like demo', production nahi."

## 1. 60-second pitch
"Ye ek platform hai jisme WooCommerce store Kubernetes par chalta hai, uske upar maine apna **custom MCP server** likha hai jo products aur orders ko tools ki tarah expose karta hai, aur ek **MCP gateway** hai jo kai MCP servers ko ek hi endpoint ke peeche jodta hai. Admin dashboard mein servers register karta hai, har team member ki apni API key hoti hai, har tool call audit hoti hai. Dashboard ka chat agent aur Claude Code jaisa external client dono **ek hi code path** se tools chalate hain, to permission aur audit bypass nahi ho sakte. Credentials sirf server par rehte hain: encrypted. Aur dead ya slow upstream baaki system ko nahi giraata."

**5-minute walkthrough ka order:** (1) diagram dikhao (`README.md`) → (2) ek tool call ka safar (`docs/SYSTEM_DESIGN.md` sequence diagram) → (3) `gateway/src/gateway/service.js` kholo: policy + audit ek jagah → (4) failure isolation (`make e2e`) → (5) Kubernetes: public vs internal + NetworkPolicy → (6) limitations honestly.

## 2. Architecture

### Q1. Ye architecture kyun? Seedha chat agent se WooCommerce kyun nahi?
Yahan maine **gateway ko beech mein rakha** kyunki assignment ki problem ye hai ki kai servers, kai users, aur ek jagah control chahiye: kaun kya call kare, kiski credential use ho, aur kisne kya kiya. Gateway ke bina har client ko har server ka credential dena padta. Isse **ek hi jagah** auth, policy, audit aur timeouts lagte hain. Agar hum chat agent ko seedha woo-mcp se jodte, to external client (Claude Code) alag raste se jaata aur audit/permission do jagah duplicate hote, aur kahin ek chhoot jaata. Limitation: gateway ek single point hai; abhi sirf ek replica hai (SQLite).

### Q2. MCP Streamable HTTP kyun?
Assignment mein required hai, aur technically ye isliye sahi hai kyunki HTTP par chalta hai: Ingress, auth headers, timeouts, aur Kubernetes Services sab seedhe kaam karte hain, stdio jaisa local process nahi chahiye. Official SDK (`@modelcontextprotocol/sdk` 1.32.1) ka `StreamableHTTPClientTransport` aur `StreamableHTTPServerTransport` use kiye hain, apna protocol nahi banaya. Agar stdio hota, to cluster ke andar kai pods ko jodna mushkil hota. Limitation: gateway stateless mode mein hai, to server-se-client push (`tools/list_changed`) nahi hai.

### Q3. woo-mcp internal-only kyun, aur ye kaise enforce hota hai?
Maine isse internal rakha kyunki iske paas store ki write power hai (products banana, order status badalna); agar ye internet par khula hota to gateway ki saari auth bypass ho jaati. Enforce **do layers** se hota hai: (1) Service type `ClusterIP` hai aur uske liye koi Ingress hai hi nahi (`charts/urumi/templates/ingress.yaml`), aur NetworkPolicy sirf gateway pods ko 3000 port par aane deti hai; (2) woo-mcp khud bearer token maangta hai, to NetworkPolicy galat ho ya CNI enforce na kare tab bhi random pod tools nahi chala sakta. (test: woo-mcp/test/woo.test.js → "MCP endpoint requires the bearer token") Limitation: NetworkPolicy ka asli enforcement maine cluster par run nahi kiya; `scripts/smoke.sh` uska test hai.

### Q4. Gateway ko kaise pata ki kis upstream ko call bhejna hai?
Tool ka naam hamesha `<slug>__<tool>` hota hai, jaise `woo__list_orders`. `GatewayService.callTool` naam ko **pehle `__` par** todta hai, slug se server milta hai, aur tool us server ki cached, validated list mein hona chahiye. Slug ki regex (`^[a-z][a-z0-9-]{1,29}$`) mein `__` ho hi nahi sakta, isliye split ka matlab ek hi nikalta hai. (test: gateway/test/gateway.test.js → "calls are routed to the RIGHT upstream even when tool names collide") Alternative "sirf collision par prefix" tha, lekin tab naya server add hote hi purane tool naam badal jaate aur clients toot jaate. Limitation: naam lambe ho jaate hain, aur 64 characters ki limit hai (slug + `__` + tool).

### Q5. Do upstreams mein same tool name ho to?
Dono `alpha__echo` aur `beta__echo` ban jaate hain, isliye collision hota hi nahi; ye deterministic hai. (test: gateway/test/gateway.test.js → "external MCP client (URL + key only) sees tools of ALL enabled servers; duplicate names are") Agar prefix na hota to ek tool doosre ko shadow kar deta aur galat server call ho sakta tha.

### Q6. Chat agent gateway ke andar kyun, alag service kyun nahi?
Isse chat aur external client **bilkul same function** (`GatewayService.callTool`) se guzarte hain, to policy aur audit ek hi jagah hain. Alag service banate to wo gateway ko HTTP se call karti aur uski identity/auth ka naya sawaal khada hota. Limitation: gateway process mein LLM client bhi hai, to LLM ka koi bug gateway ko affect kar sakta hai; isliye chat ke saath step/time/rate limits hain.

## 3. Authentication aur keys

### Q7. API keys hash kyun karte ho?
Maine raw key database mein nahi rakhi kyunki agar DB ya volume snapshot leak ho, to keys seedha use na ho paayein. Sirf SHA-256 hash store hota hai; incoming key ka hash nikaal ke match karte hain. Key ek hi baar dikhti hai (jab banti hai). (test: gateway/test/db.test.js → "issued key authenticates; DB never stores the raw key") Agar raw rakhte to DB leak = sab accounts leak. Limitation: key kho gayi to recover nahi hoti, naya banana padta hai.

### Q8. bcrypt kyun nahi, SHA-256 kyun?
bcrypt **kam-entropy passwords** ke liye hai (log "password123" rakhte hain, to slow hash zaroori hai). Hamari key 32 random bytes (256-bit) hai, to brute force impossible hai, aur har MCP request par slow hash lagana sirf latency badhata. To SHA-256 theek hai. Agar key insaan ka chuna hua password hota to ye galat hota. Code: `hashApiKey` in `gateway/src/security/apikeys.js`.

```js
// from: gateway/src/security/apikeys.js
export function generateApiKey() {
  const prefix = randomBytes(6).toString('base64url').slice(0, 8);
  const secret = randomBytes(32).toString('base64url'); // 43 chars
  const raw = `umk_${prefix}_${secret}`;
  return { raw, prefix: `umk_${prefix}`, hash: hashApiKey(raw) };
}

export function hashApiKey(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
```

**Decode:** `generateApiKey` mein prefix sirf dikhane ke liye hai (UI mein pehchaan), asli bharosa 32 random bytes par hai; DB mein sirf `hash` jaata hai, `raw` sirf ek baar caller ko milta hai.


`randomBytes(32)` OS ka CSPRNG hai (`Math.random` predictable hota), aur `.toString('base64url')` URL/header-safe text deta hai.

### Q9. Revocation kaise kaam karta hai?
Har request par DB mein key ka hash dhoondhte hain, aur agar `revoked_at` set hai ya user disabled hai to `null` return hota hai, yani 401. Isliye revoke ke **agle hi request** par access band. Dashboard session bhi us key se bandha hai, to revoke par uske sessions bhi delete hote hain. (test: gateway/test/auth.test.js → "revoking a key kills its live dashboard session and API access IMMEDIATELY") Agar ye check hata dein to revoked key chalti rehti; maine ye jaan-boojhkar hata ke dekha: `e2e/sabotage.sh` mein "revocation ignored" case e2e ke scenario 7 ko fail kar deta hai. Limitation: har request par ek DB lookup, aur multi-replica ke liye shared DB chahiye.

```js
// from: gateway/src/db/database.js
authenticate(rawKey) {
  if (!looksLikeApiKey(rawKey)) return null;
  const row = q(`SELECT k.id key_id, k.revoked_at, u.* FROM api_keys k JOIN users u ON u.id=k.user_id
                 WHERE k.key_hash=?`).get(hashApiKey(rawKey));
  if (!row || row.revoked_at || row.disabled) return null;
  q('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now(), row.key_id);
  return { id: row.id, email: row.email, name: row.name, role: row.role, keyId: row.key_id };
},
```

**Decode:** `looksLikeApiKey` pehle format check karta hai, to garbage input DB tak jaata hi nahi. Phir `hashApiKey(rawKey)` se lookup. `row.revoked_at || row.disabled` wahi line hai jo revocation aur disable enforce karti hai (sabotage test isi line ko hata ke e2e fail karwata hai). `last_used_at` dashboard par 'last used' dikhane ke liye update hota hai.


### Q10. Dashboard login kaise kaam karta hai? Key browser mein kyun nahi rakhte?
User apni key paste karta hai, server hash verify karke ek **alag random session token** deta hai jo `HttpOnly; SameSite=Strict` cookie mein jaata hai (production mein `Secure` aur `__Host-` prefix). Key sirf login request ke body mein ek baar jaati hai aur UI use turant clear kar deta hai; browser mein localStorage/sessionStorage kuch nahi (ek static test isey enforce karta hai: dashboard/test/static.test.js). HttpOnly ka matlab JavaScript cookie padh nahi sakti, to XSS se token churana mushkil. Session ki limit: 8 ghante total, 1 ghanta idle.

### Q11. Session aur key ka rishta kya hai, aur kyun?
Session row `key_id` store karta hai, aur har request par `sessions → api_keys → users` join hota hai. Isse key revoke ya user disable hote hi session mar jaata hai, aur role bhi live DB se aata hai (demote karne par turant asar).

```js
// from: gateway/src/db/database.js
const r = q(`SELECT s.*, k.revoked_at key_revoked, u.email, u.name, u.role, u.disabled
             FROM sessions s JOIN api_keys k ON k.id=s.key_id JOIN users u ON u.id=s.user_id WHERE s.id=?`).get(id);
if (!r) return null;
const t = Date.parse(now());
const dead = Date.parse(r.expires_at) <= t || t - Date.parse(r.last_seen_at) > idleMs || r.key_revoked || r.disabled;
if (dead) { q('DELETE FROM sessions WHERE id=?').run(id); return null; }
```

**Decode:** Ek hi query mein session, uski key aur user join hote hain. `dead` condition chaar baatein ek saath dekhti hai: absolute expiry, idle timeout, key revoked, user disabled. Koi bhi sach ho to session row **delete** ho jaati hai aur `null` milta hai, yani 401.


### Q12. CSRF se kaise bachte ho?
Teen layers: `SameSite=Strict` cookie, har cookie-wala POST/PATCH/DELETE par `X-CSRF-Token` header (jo JS memory mein rehta hai, storage mein nahi), aur agar browser `Origin` bhejta hai to wo allowed list mein hona chahiye. Bearer key wale requests ko CSRF token nahi chahiye kyunki wo ambient credential nahi hain. `/mcp` cookies accept hi nahi karta. (test: gateway/test/auth.test.js → "CSRF: cookie-authenticated POST without token")

```js
// from: gateway/src/http/middleware.js
const csrf = (req, res, next) => {
  if (SAFE.has(req.method) || req.auth?.via !== 'session') return next();
  if (!originAllowed(req, config.allowedOrigins)) return res.status(403).json({ error: 'bad_origin' });
  const sent = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
  const want = Buffer.from(req.auth.csrf);
  if (sent.length !== want.length || !timingSafeEqual(sent, want)) return res.status(403).json({ error: 'csrf_failed' });
  next();
};
```

**Decode:** `SAFE.has(req.method)` wale (GET) aur Bearer-key wale requests ko chhodta hai; sirf cookie-authenticated writes check hote hain. `timingSafeEqual` isliye ki compare ka time se token guess na ho, aur length pehle check hoti hai kyunki `timingSafeEqual` alag lengths par error deta hai.


### Q13. Admin aur member ka farq kaise enforce hota hai? Frontend mein button chhupana kaafi hai?
Nahi, aur maine sirf button chhupakar kaam nahi chalaya. Har admin route `requireRole('admin')` se guzarta hai, jo role ko **database se** padhta hai (cookie se nahi, to forge nahi ho sakta). Member ko 403 milta hai, aur doosre ki key ke id par 404 (taaki ids guess na ho). (test: gateway/test/auth.test.js → "role restrictions: member gets 403 on every admin endpoint") Dashboard ka contract test real server par member ko har admin API par 403 dikhata hai (test: gateway/test/dashboard-contract.test.js → "member journey").

### Q14. Pehla admin kaise banta hai? Aur key log mein kyun nahi aati?
Bootstrap key Kubernetes Secret se env mein aati hai (`BOOTSTRAP_ADMIN_API_KEY`), startup par sirf uska hash store hota hai, aur logger sensitive field names drop karta hai aur `umk_…` jaise patterns mask karta hai. (test: gateway/test/db.test.js → "bootstrap admin seeds once and key works"; e2e step "gateway process logs contain no API keys or upstream tokens") Limitation: pehli baar admin ko key `kubectl get secret` se nikalni padti hai.

## 4. Gateway aur MCP internals

### Q15. Initialization aur tool discovery kaise hota hai?
Client `POST /mcp` par `initialize` bhejta hai, phir `tools/list`. Gateway har HTTP request par ek **naya MCP Server + transport** banata hai (stateless mode), us request ki Bearer key authenticate karta hai, aur `tools/list` ka jawab **memory ke cache** se deta hai (user ke deny-rules apply karke). Cache ko background mein har 30 s refresh karta hai `UpstreamManager`. File: `gateway/src/gateway/mcpEndpoint.js`.

```js
// from: gateway/src/gateway/mcpEndpoint.js
const server = new Server({ name: 'urumi-mcp-gateway', version },
  { capabilities: { tools: {} }, instructions: 'Tools are namespaced as <server>__<tool>.' });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: service.listTools(user) }));
server.setRequestHandler(CallToolRequestSchema, async (r, extra) =>
  service.callTool({ user, source: 'mcp', name: r.params.name, args: r.params.arguments, signal: extra.signal }));
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
```

**Decode:** Har request par naya `Server` aur transport. `sessionIdGenerator: undefined` = stateless; `enableJsonResponse: true` = SSE ki jagah seedha JSON. `res.on('close')` cleanup karta hai. `extra.signal` se client disconnect hone par upstream call bhi abort hoti hai. Dhyan do: handlers `service.listTools(user)` aur `service.callTool({ user, ... })` ko us request ke `user` ke saath bulate hain.


Stateless isliye chuna kyunki isse **revocation turant** hoti hai (har request ki key check) aur koi session map memory mein nahi (restart-safe, baad mein replicas ke liye aasaan). Alternative stateful sessions the, lekin unmein har request par session ko user se re-validate karna padta aur revoked key ka session zinda reh sakta tha. Limitation: server push nahi.

### Q16. Slow upstream ko kaise isolate karte ho?
Teen cheezein: (1) `tools/list` network par jaata hi nahi, cache se aata hai; (2) har step ka apna timeout (connect 5 s, list 8 s, call 30 s); (3) refresh `Promise.allSettled` se **parallel** hota hai, to ek slow server dusron ko late nahi karta. (test: gateway/test/gateway.test.js → "SLOW upstream: call times out with clear error and does NOT block calls to other upstreams") Test mein slow tool 400 ms par timeout hota hai aur usi dauran doosre upstream ka call 300 ms se kam mein aa jaata hai. Agar cache na hota to har listing sabse slow server ka intezaar karti.

```js
// from: gateway/src/gateway/service.js
const m = typeof name === 'string' ? SLUG_TOOL.exec(name) : null; // split at FIRST "__" (slugs can't contain "__")
if (!m) throw new GatewayError('unknown_tool', 'Tool not available');
[, slug, tool] = m;
if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw new GatewayError('invalid_arguments', 'Tool arguments must be an object');
if (args && JSON.stringify(args).length > this.limits.maxArgBytes) throw new GatewayError('invalid_arguments', 'Tool arguments too large');
if (this.db.isToolDenied(user, slug, tool)) { summary = 'forbidden'; throw new GatewayError('unknown_tool', 'Tool not available'); } // same message as unknown: don't reveal hidden tools
result = await this.manager.call({ slug, tool, args, signal });
```

**Decode:** Naam ko regex se `slug` aur `tool` mein todta hai (pehle `__` par). Arguments object hona chahiye aur 256 KB se chhote. Deny-rule laga ho to summary `forbidden` rakhta hai par error message wahi 'Tool not available' deta hai jo unknown tool ka hota hai. Uske baad `manager.call`; baaki function (catch/audit) iske baad aata hai, isliye har raaste par audit row banti hai.


### Q17. Upstream dead ho to?
Connect fail hone par status `unreachable` ban jaata hai reason ke saath (jaise `connection: ECONNREFUSED`), tools list se hat jaate hain, aur **5 s ka cooldown** hota hai: us dauran naye calls turant "unreachable" error dete hain, har call poora connect timeout nahi bharti. Background refresh (30 s) apne aap reconnect karta hai. (tests: gateway/test/gateway.test.js → "DEAD upstream at registration"; "upstream dies AFTER being connected") Gateway ka `/readyz` upstreams ko dekhta hi nahi, to dead upstream gateway ko unready nahi karta (test: gateway/test/gateway.test.js → "MALFORMED upstream and REDIRECTING upstream").

```js
// from: gateway/src/gateway/upstreams.js
async #ensureClient(server, st, { force = false } = {}) {
  if (st.client) return st.client;
  if (!force && st.status === 'unreachable' && Date.now() - st.failedAt < this.timeouts.cooldownMs)
    throw new GatewayError('unreachable', `Upstream "${server.slug}" is unreachable (${st.error})`); // fail fast
  st.connecting ??= this.#connect(server).finally(() => { st.connecting = null; }); // one connect at a time per server
  const client = await st.connecting;
  if (this.states.get(server.id) !== st) { closeQuietly(client); throw new GatewayError('unreachable', `Upstream "${server.slug}" was reconfigured`); }
  st.client = client;
  return client;
}
```

**Decode:** Agar server `unreachable` hai aur `failedAt` se cooldown nahi gaya to turant error (fail fast). `st.connecting ??=` ek hi connect ek waqt par chalne deta hai (promise share hota hai). Aakhir mein check hota hai ki beech mein admin ne server edit to nahi kar diya (`this.states.get(server.id) !== st`), aise mein naya client band kar dete hain.


### Q18. Tool call fail ho to retry kyun nahi karte?
`create_product` jaisa tool **idempotent nahi** hai. Agar pehla call ambiguous tareeke se fail hua (response kho gaya par product ban gaya), retry se duplicate product banega. Isliye error client/user ko jaata hai, aur woo-mcp ke tools ke annotations bhi batate hain ki kaun idempotent hai (`update_order_status` hai, `create_product` nahi). Limitation: transient failure par user ko khud dobara try karna padta hai.

### Q19. Upstream ke tools/descriptions par bharosa kyun nahi karte?
Wo third-party text hai jo model tak pahunchta hai. Isliye: tool naam regex se check, description 600 chars tak cut + control characters hata ke, har description par `[slug]` prefix (kisne likha), schema 16 KB cap, result 256 KB cap, aur redirects follow nahi hote. (test: gateway/test/gateway.test.js → "hostile upstream output is bounded") Limitation: ye prompt injection ko **rokta nahi**, sirf uska scope chhota karta hai (threat model dekho).

### Q20. Upstream ko user ki key kyun nahi dete?
Agar user ki gateway key upstream ko jaati, to wo (khaaskar third-party) us key ko replay karke gateway par us user ban sakta tha, aur upstream ko pata hi nahi chalta ki token uske liye tha ya nahi (confused deputy). Isliye gateway **server ka apna credential** lagata hai. (test: gateway/test/gateway.test.js → "the caller's gateway key is NEVER forwarded") Limitation: upstream per-user permission nahi laga sakta; saari per-user policy gateway mein hai.

### Q21. Per-user tool filtering kaise kaam karti hai?
`tool_rules` table mein deny-rules hain (role=member ya specific user, server, tool ya `*`). `listTools` rule wale tools **chhupa deta hai** aur `callTool` unhe **reject** karta hai; denied aur unknown tool ka message same hai taaki member hidden tool ka existence guess na kar sake. Admin par rules lagte hi nahi taaki koi khud ko lock-out na kare. (test: gateway/test/gateway.test.js → "per-user tool filtering") Limitation: iska dashboard UI nahi hai (API hai).

### Q22. Audit log mein kya jaata hai, kya nahi?
User, source (`mcp` ya `chat`), server, tool, timestamp, duration, success/fail aur ek chhota safe error summary. **Arguments aur results store nahi hote** (privacy + secrets ka risk), aur summary mein bearer-jaise patterns mask hote hain. (test: gateway/test/gateway.test.js → "audit log: right user/server/tool/outcome/duration") E2E mein 12 calls ka audit rows se exact comparison hota hai.

### Q23. Gateway restart ho to kya hota hai? Upstream pod restart ho to?
Gateway: users, keys, sessions, servers, audit sab SQLite (PVC) mein hain, to bache rehte hain; tool cache kuch seconds mein dobara bharta hai (tab tak "connecting"); login aur chat ke in-memory rate-limit counters reset ho jaate hain. Upstream: stateless hai to pod badalne par calls chalte rehte hain; down ke dauran `unreachable`, wapas aane par agle refresh (≤30 s) mein connected. (e2e scenario 9 process kill + auto-reconnect dikhata hai; real pod restart cluster par verify karna baaki hai.)

## 5. woo-mcp aur WooCommerce

### Q24. WooCommerce se baat karne ke liye REST API kyun, WP-CLI ya direct DB kyun nahi?
REST documented aur versioned contract hai, aur WooCommerce khud validation/permissions lagata rehta hai. woo-mcp ko sirf network par ek scoped, revoke-able consumer key chahiye. WP-CLI ke liye WordPress pod mein exec-level access chahiye (bahut broad), aur direct SQL WooCommerce ki business logic ko bypass karta hai. Limitation: ek extra HTTP hop, aur WooCommerce basic-auth sirf HTTPS par kaam karta hai, isliye in-cluster plain HTTP ke liye `X-Forwarded-Proto: https` bhejne ka workaround hai (`woo-mcp/src/wc.js`, `wp-config` mein header trust). **Ye real WooCommerce ke saath maine test nahi kiya.**

### Q25. Customer ka personal data kyun nahi nikalte?
WooCommerce order mein naam, email, phone, address hota hai; "aaj ke orders" jaise sawaal ko ye nahi chahiye, aur ye chat history aur LLM provider tak pahunchta. `shapeOrder` sirf whitelist fields deta hai, to WooCommerce kal naye fields bhi jode to leak nahi hote. (test: woo-mcp/test/woo.test.js → "shapeOrder drops unknown/sensitive fields") 

### Q26. "Aaj" ka matlab kaun tay karta hai?
`list_orders` mein `created_today` option hai jo **store ke timezone** (`WC_TIMEZONE`) mein aaj ka midnight nikalta hai, kyunki model ko tareekh nahi pata aur UTC se IST mein raat 12 se subah 5:30 tak ke orders galat din mein ginte. (test: woo-mcp/test/woo.test.js → "list_orders: created_today uses STORE timezone") Limitation: WooCommerce ka `after` parameter real store par kis timezone mein interpret hota hai, ye maine verify nahi kiya.

### Q27. Invalid input WooCommerce tak kyun nahi jaata?
zod schemas har tool par lagi hain (price `^\d{1,9}(\.\d{1,2})?$`, naam 1-200 chars, status enum), to galat input pehle hi reject. (test: woo-mcp/test/woo.test.js → "create_product rejects bad input BEFORE calling WooCommerce")

## 6. Chat agent

### Q28. Chat agent tool calls kaise karta hai? Ye sach mein loop hai ya nakli?
Loop: model ko history + **us user ke filtered tools** bhejte hain; model `tool_calls` deta hai; har call `service.callTool` se **user ke naam par** chalti hai; result `tool` message ban ke wapas model ko jaata hai; jab tak model plain answer na de (ya limits na lag jaayein). Test mein check hota hai ki model ko agle turn par dono tool results `tool_call_id` ke saath actually mile. (test: gateway/test/chat.test.js → "REAL tool loop: multi-step") File: `gateway/src/chat/agent.js`.

```js
// from: gateway/src/chat/agent.js
if (!reauth()) throw new AgentAborted('session ended');
let args; try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = call.function.arguments; } // string => service rejects as invalid_arguments (and audits it)
const t0 = performance.now();
const result = await service.callTool({ user, source: 'chat', name: call.function.name, args, signal });
const text = resultText(result);
const [server, ...rest] = call.function.name.split('__');
trace.push({ id: call.id, name: call.function.name, server: rest.length ? server : null, tool: rest.length ? rest.join('__') : call.function.name,
  arguments: args && typeof args === 'object' ? args : null, isError: !!result.isError, result: text.slice(0, 2000), durationMs: Math.round(performance.now() - t0) });
messages.push({ role: 'tool', tool_call_id: call.id, content: text.slice(0, limits.maxToolResultChars) });
```

**Decode:** `reauth()` har tool se pehle chalta hai (revoke ho gaya to loop ruk jaata hai). Model ke `arguments` ek JSON **string** hote hain; parse fail ho to string hi aage jaati hai taaki `callTool` use `invalid_arguments` ke roop mein reject kare **aur audit kare**. Natija `tool` role ke message mein, `tool_call_id` ke saath, model ko wapas jaata hai.


### Q29. Agent logged-in user ki tarah kaise act karta hai?
`req.auth.user` seedha `callTool` mein jaata hai, audit mein `source: 'chat'` aur us user ka email aata hai. Agent ko tools bhi usi user ke filtered milte hain. E2E mein Alice ke chat calls ka audit exactly Alice ke naam par verify hua.

### Q30. Real LLM ke saath test kiya?
**Nahi.** Sandbox se OpenAI reachable nahi tha aur koi key nahi thi. Provider ko ek fake OpenAI-compatible HTTP server ke against test kiya (request ka format, tool results ka round-trip, errors), jo sirf protocol conformance proof hai. (test: gateway/test/chat.test.js → "OpenAI-compatible provider: correct wire format") Default mock mode scripted hai aur har reply par `[MOCK MODE: ...]` likhta hai. Real model par jaane ke liye `LLM_PROVIDER=openai`, `LLM_MODEL`, `OPENAI_API_KEY`.

### Q31. Prompt injection se kaise bachte ho?
Poori tarah nahi bachte; ye main manta hoon. Structural mitigations: system prompt tool output ko untrusted data kehta hai; tool results `tool` role mein jaate hain, kabhi `system`/`user` mein nahi; browser `system`/`tool` messages bhej hi nahi sakta; model ko sirf user ke allowed tools dikhte hain; step/call/size/time caps. (tests: gateway/test/chat.test.js → "prompt-injection hygiene"; "client cannot forge system/tool messages") Ye test sirf ye prove karta hai ki **loop** injected text ko data maanta hai, ye nahi ki real LLM use ignore karega. Gap: write tools ke liye human confirmation nahi hai.

### Q32. Chat ke beech key revoke ho jaye to?
Har tool chalane se pehle `reauth()` key aur user DB se dobara dekhta hai; revoke ho gayi to loop ruk jaata hai (401 `session_ended`), na tool chalta hai na audit row banti hai. (test: gateway/test/chat.test.js → "revoking the key MID-CHAT")

### Q33. Chat par limits kya hain aur kyun?
Max 6 steps, 4 tool calls per step, 20 messages/min per user, 120 s total, tool result model ko 8000 chars tak. Warna ek bhatakta model ya shararati user LLM bill aur gateway ke resources khaa sakta hai; browser band ho jaye to request abort hoti hai. (test: gateway/test/chat.test.js → "max-steps cap"; "chat rate limit per user") Gap: OpenAI provider model ko max 128 tools hi dikhata hai (`MAX_TOOLS`); us se zyada tools ho to baaki chhup jaate hain; "tool search" wala approach maine nahi banaya.

## 7. Dashboard

### Q34. Dashboard mein sab kuch server enforce karta hai, to UI ka kaam kya?
UI sirf convenience hai: admin ko Servers/Team dikhte hain, member ko read-only Tools. Asli limit server par hai (Q13). Isliye contract test real server ke saath chalta hai. (test: gateway/test/dashboard-contract.test.js → "admin journey through the real UI client") Dashboard ko maine kisi **real browser mein nahi khola** (sandbox mein browser nahi tha); layout, responsive aur dark mode manual check chahiye.

### Q35. Credential ya key frontend tak kyun nahi pahunchti?
API server credential ke liye sirf `hasCredential: true/false` deti hai (`serializers.js` whitelist karta hai, naya column default private rehta hai), key sirf creation par ek baar dikhti hai ek dialog mein jo band karte hi DOM se hat jaata hai. (tests: dashboard/test/app.test.jsx → "API keys: generated key is shown once"; gateway/test/auth.test.js → "API responses never contain key hashes")

## 8. Kubernetes aur Helm

### Q36. Har resource kyun hai? (jaldi se)
**Deployment** (stateless: woo-mcp, demo x2, dashboard, gateway, WordPress), **StatefulSet** (MariaDB: stable storage), **Service ClusterIP** (cluster ke andar naam se pahunch), **Ingress x3** (shop host, dashboard host, aur `/api` + `/mcp` gateway ko, ek hi host par taaki cookie same-origin rahe), **Secret** (credentials), **PVC** (MariaDB, WordPress content, gateway DB), **ServiceAccount x7** (har ek `automountServiceAccountToken: false` aur koi Role nahi, kyunki koi pod Kubernetes API se baat nahi karta), **NetworkPolicy x9**, **ConfigMap** (wp-cli setup script).

### Q37. Kaun public hai aur kaun internal?
Public: `shop.<domain>` (WordPress) aur `dashboard.<domain>` (`/` dashboard, `/api` + `/mcp` gateway). Internal: woo-mcp, demo servers, MariaDB: ClusterIP, koi Ingress nahi, aur NetworkPolicy se sirf allowed pods. Chart ke static checker mein ek check hai ki "internal services Ingress se expose na hon" aur mutation test ne use pakda (`charts/tools/test_checker.py`).

### Q38. NetworkPolicy kaise kaam karti hai, aur kya garanteed hai?
Pehle `default-deny` (ingress + egress dono) lagta hai sab pods par, phir sirf zaroori edges khulte hain: Ingress controller → WordPress/dashboard/gateway; gateway → woo-mcp/demo servers; woo-mcp → WordPress → MariaDB; internet egress me private ranges aur `169.254.0.0/16` excluded. Isse ek compromised pod ke aage badhne ke raaste band hote hain. **Garantee nahi**: policy tabhi kaam karti hai jab CNI enforce kare (kind ka default kindnet nahi karta, isliye `scripts/kind-up.sh` Calico lagata hai). Maine ise run nahi kiya.

```yaml
# from: charts/urumi/templates/networkpolicy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ $fn }}-default-deny
  labels:
    {{- include "urumi.labels" (dict "root" . "component" "network") | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/instance: {{ .Release.Name }}
  policyTypes: ["Ingress", "Egress"]
```

**Decode:** `podSelector` sirf is release ke pods chunta hai. `policyTypes` mein Ingress aur Egress dono hain aur **koi rule nahi**, yani sab kuch deny. Uske baad alag NetworkPolicies sirf zaroori edges kholti hain.


### Q39. Readiness aur liveness probes ka kaam kya hai, is deployment mein?
**Readiness** batata hai pod traffic ke layak hai ya nahi (fail ho to Service se hat jaata hai, restart nahi). **Liveness** batata hai process atak gaya (fail ho to restart). **Startup** probe dheeme starts (WordPress/MariaDB first boot) ko liveness se bachata hai. Gateway ka readiness `/readyz` sirf DB dekhta hai, upstreams nahi, taaki ek dead upstream gateway ko traffic se na hata de. MariaDB ka readiness `mariadb-admin ping` hai, liveness sirf TCP, taaki ek slow query restart na kare. Wp-cli sidecar ki sirf liveness hai (heartbeat file), readiness nahi, taaki WooCommerce download fail hone par storefront na chhupe.

### Q40. Requests/limits kyun?
Requests scheduler ko batati hain ki kitna reserve karna hai; limits ek runaway process ko poora node khane se rokti hain (memory limit par OOM-kill, sirf us container ka). Har container ke liye set hain, ek static check enforce karta hai (`charts/tools/check_manifests.py`); values `charts/urumi/values.yaml` mein.

### Q41. Pod mar jaye to data kahan jaata hai?
MariaDB, WordPress content aur gateway DB PVC par hain, to pod ya node-process mar jaaye to naya pod usi volume ko mount karta hai. Pod ka `/tmp` (emptyDir) mit jaata hai, jo theek hai. Limitation: `local-path` (k3s) node-local hai, to node mara to HA nahi; backup alag chahiye. WordPress aur gateway `Recreate` strategy par hain (RWO volume), to upgrade par chhota outage.

### Q42. Secrets kaise manage hote hain?
Local: chart pehli install par random generate karta hai aur `lookup` se **upgrade par wahi reuse** karta hai; warna har `helm upgrade` encryption key badal deta aur stored upstream credentials undecryptable ho jaate. Production: `scripts/create-prod-secrets.sh` out-of-band Secret banata hai (`secrets.existingSecret`), taaki values Helm release history mein na jaayein.

```yaml
# from: charts/urumi/templates/secrets.yaml
{{- $existing := lookup "v1" "Secret" .Release.Namespace $name }}
{{- $old := dict }}
{{- if $existing }}{{- $old = $existing.data }}{{- end }}
```

**Decode:** `lookup` cluster se maujooda Secret padhta hai. Agar mila to uski values `$old` mein aati hain aur `urumi.plain` helper unhe reuse karta hai; `helm template` jaisi cluster-less rendering mein `lookup` khaali deta hai, to naye values banti hain.


Limitation: Kubernetes Secrets default mein sirf base64 hain (etcd encryption cluster ka kaam hai); `GATEWAY_ENCRYPTION_KEY` kho jaaye to credentials recover nahi hote.

### Q43. Local aur production Helm values mein kya badalta hai?
Sirf values: domain (`localtest.me` vs apna), scheme/cookies (`http`, non-Secure vs `https`, `Secure`+`__Host-`), ingress class (nginx vs Traefik) aur uska controller namespace (NetworkPolicy ke liye), storage class, Secret strategy, aur LLM provider. Templates same. Table: `docs/DEPLOYMENT.md`. Static check ne ek real bug pakda: nginx annotations defaults mein the aur prod override `{}` unhe hata nahi paaya (Helm maps ko merge karta hai).

### Q44. Upgrade aur rollback?
`helm upgrade --atomic` (pods Ready na hon to khud rollback), `helm history`, `helm rollback`. Rollback **data ko nahi lautaata**, sirf Kubernetes objects aur image tags ko; gateway ka schema `CREATE TABLE IF NOT EXISTS` hai, migrations nahi. Maine ye exercise nahi kiya, sirf documented hai.

## 9. Security

### Q45. SSRF se kaise bachte ho jab admin URL register karta hai?
Admin ka URL gateway (jo cluster ke andar hai) khud fetch karta hai, to wo cloud metadata (`169.254.169.254`) ya internal services tak pahunchne ka zariya ban sakta hai. Isliye: sirf http/https, URL mein user:pass nahi; **metadata/link-local/reserved addresses hamesha blocked** (koi override nahi); private/loopback tabhi jab hostname **exact allowlist** mein ho; DNS ke **saare answers** check hote hain; har connect par dobara check; redirects follow nahi hote. IPv4-mapped IPv6 (`::ffff:169.254.169.254`) bhi classify hota hai, kyunki wo common bypass hai. (tests: gateway/test/security.test.js → "ssrf: DNS name resolving to metadata IP is blocked"; gateway/test/gateway.test.js → "SSRF: metadata, private-not-allowlisted") Allowlist exact hostnames ki hai, wildcard nahi, taaki admin gateway ko WordPress ya MariaDB par point na kar sake. Limitation: DNS rebinding (check ke baad DNS badalna) narrow hua hai, khatam nahi; doosri layer NetworkPolicy egress hai (cluster par unverified).

```js
// from: gateway/src/security/ssrf.js
// IPv4-mapped (::ffff:a.b.c.d) must be judged by the embedded v4 address, else it is a bypass.
const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
if (mapped) return classifyIp(mapped[1]);
```

**Decode:** IPv6 address ke andar IPv4 chhupa ke bhejna (`::ffff:169.254.169.254`) ek common SSRF bypass hai; isliye mapped address ko andar wale IPv4 se classify karte hain.


### Q46. Admin credential chura sakta hai kya?
Padhne nahi, par **ek raasta mila tha** jab maine threat model likha: admin server ka URL badal ke apne host par point kar sakta tha aur stored credential wahan chala jaata. Maine fix kiya: jis server par stored credential hai uska URL badalne par credential **dobara enter karna padta hai**, aur test dikhata hai ki attacker host par koi request hi nahi aati. (test: gateway/test/gateway.test.js → "credential exfiltration") Ye interview mein ek achhi kahani hai: tumne khud apni design mein hole dhoondha aur band kiya.

### Q47. Ek member doosre member ka kya bigaad sakta hai?
Doosre ki key dekh ya revoke nahi kar sakta (404/403), uska audit nahi dekh sakta, uska chat nahi dekh sakta (server par store hi nahi hota), aur admin nahi ban sakta. **Par**: store ka data sab members share karte hain (ek hi WooCommerce credential), aur `/mcp` calls par rate limit nahi hai, to ek member bhari load daal sakta hai. (test: gateway/test/auth.test.js → "member can only see/manage own keys") Ye gaps threat model mein likhe hain.

### Q48. Agar admin koi malicious MCP server add kar de?
SSRF guard use internal/metadata tak nahi jaane deta; wo sirf apna credential paata hai (kisi aur ka nahi, Q46); output size/timeouts bounded hain. **Lekin** wo un calls ke arguments dekh sakta hai jo uske paas route hon, jhooth bol sakta hai, aur prompt injection try kar sakta hai jo model ko user ke doosre allowed tools chalane ko uksa sakta hai. Mitigation: sirf trusted servers register karo, members ke liye write tools deny karo; human confirmation maine nahi banaya.

### Q49. Shared upstream credential se member kya kar sakta hai jo use kabhi dekhta nahi?
Credential dekh ya nikaal nahi sakta (API mein hai hi nahi, encrypted, sirf registered URL par jaata hai), lekin **us credential ki taaqat kaam mein la sakta hai** un tools ke zariye jo use allowed hain; gateway ek confused deputy ki tarah hai by design. Control: tool deny-rules, argument validation woo-mcp mein, har call ka audit. Gap: WooCommerce key `read_write` hai.

## 10. Testing aur honesty

### Q50. Kaun sa test kya prove karta hai? (cheat sheet)
| Claim | Test |
|---|---|
| keys hashed, DB mein raw nahi | gateway/test/db.test.js → "issued key authenticates; DB never stores the raw key" |
| revoke = turant | gateway/test/auth.test.js → "revoking a key kills its live dashboard session" ; e2e scenario 7 |
| CSRF/Origin | gateway/test/auth.test.js → "CSRF: cookie-authenticated POST without token" |
| member admin API nahi chala sakta | gateway/test/auth.test.js → "role restrictions" |
| duplicate names, sahi routing | gateway/test/gateway.test.js → "calls are routed to the RIGHT upstream" |
| slow/dead upstream isolation | gateway/test/gateway.test.js → "SLOW upstream", "DEAD upstream at registration" |
| upstream ko user key nahi jaati | gateway/test/gateway.test.js → "the caller's gateway key is NEVER forwarded" |
| chat loop asli hai | gateway/test/chat.test.js → "REAL tool loop: multi-step" |
| dashboard real server ke saath | gateway/test/dashboard-contract.test.js → "admin journey through the real UI client" |
| woo-mcp PII leak nahi karta | woo-mcp/test/woo.test.js → "list_orders: created_today uses STORE timezone" |
| 10 scenarios real processes par | `make e2e` → `docs/E2E_LAST_RUN.md` |

### Q51. Tumhare tests khud sahi hain, ye kaise pata?
Maine **mutation testing** ki: `e2e/sabotage.sh` gateway mein jaan-boojhkar 5 bug daalta hai (revocation ignore, chat audit skip, dead upstream ke tools dikhana, per-user filter hataana, disabled server callable) aur har baar e2e fail hona chahiye; 5/5 pakde gaye. Aise hi chart checker ko 22 injected faults se test kiya (`charts/tools/test_checker.py`). Ek test jo kabhi fail hi nahi hota kuch prove nahi karta.

### Q52. Kya-kya verify NAHI hua?
Real WooCommerce (storefront, checkout, wp-cli install, REST key insert), real LLM, `docker build`, real `helm lint/install`, koi bhi pod chalna, probes, PVC bind, Ingress routing, NetworkPolicy enforcement, cert-manager TLS, real pod-kill, real browser mein dashboard, Claude Code/Cursor/MCP Inspector. Chart ko Helm ki jagah ek chhote stand-in renderer se aur `kubeconform` (Kubernetes 1.31 strict schemas: 37 aur 36 resources valid) se check kiya; `scripts/verify-chart.sh` jahan `helm` ho wahan real helm chalata hai.

## 11. "Tumne kaunsi galtiyan ki, kya seekha?" (stories)
1. **Credential redirect hole** (Q46): threat model likhte waqt mila, fix + test.
2. **Modal focus bug**: Invite form mein Email type nahi ho raha tha; wajah: `Modal` ka `useEffect` `[onClose]` par depend karta tha aur `onClose` har render naya function tha, to har keystroke par focus pehle field par wapas kheench liya jaata. Fix: `onClose` ko ref mein rakha, focus sirf mount par. Regression test hai (dashboard/test/app.test.jsx → "REGRESSION: typing in a second field").
3. **Label accessibility**: hint text `<label>` ke andar tha, screen reader poora paragraph naam ki tarah sunta; ab `aria-describedby`.
4. **Prod Ingress par nginx annotations**: Helm maps merge karta hai, `{}` override default ko hata nahi sakta; ab controller-specific keys sirf local values mein.
5. **E2E hang**: `kill()` sirf `exitCode` dekhta tha, signal se maare process ka `exitCode` null hota hai; to cleanup mein ek hi process ke exit ka intezaar hamesha hota. Debug markers laga ke pakda.
6. **Galat evidence commit ho gaya**: sabotage runs ne `E2E_LAST_RUN.md` ko FAIL results se overwrite kiya aur wo commit ho gaya; ab sabotage runs alag report file mein likhte hain.
7. **Ek mutant "MISSED"**: disabled server do independent layers se protected hai, ek hatane par dusri bacha leti hai (equivalent mutant); dono ek saath hata kar test kiya.
8. **Test count galat likha** (110 vs asli 108): docs mein numbers bhi verify karne chahiye; `docs/check_docs.py` ab claims ko code se milata hai.

## 12. Trap questions
* **"Ye sab tumne khud likha?"** "AI tools ki madad se, aur mujhe har hissa samajh aata hai; dekho, kisi bhi file se pooch lo." Tab 5-minute walkthrough (Section 1) aur Q4/Q9/Q16 ready rakho.
* **"Production ready hai?"** Section 0.
* **"Kubernetes par chalaya?"** Seedha: "Nahi, ye mere laptop par karne wala hissa hai; sandbox mein cluster nahi tha. Static validation ki, aur smoke script likhi hai."
* **"LLM test kiya?"** Q30.
* **"Isolation kaise prove karoge?"** `scripts/smoke.sh` (unrelated pod woo-mcp/MariaDB tak nahi pahunch sakta, gateway pahunch sakta hai); Calico chahiye.
* **"Gateway restart ho to sessions?"** Sessions DB mein hain, to bache rehte hain (Q23).
* **"Do replicas chalaoge to?"** Abhi nahi: SQLite RWO volume, in-memory rate limits. Postgres + shared limiter chahiye.
* **"Tool 500 ho gaya, retry?"** Q18.
* **"Ek member bahut calls kare?"** `/mcp` par rate limit nahi hai; chat par hai. Gap maan lo, fix batao (per-user token bucket).

## 13. Code kholne ka map
| Sawaal | Kholo |
|---|---|
| keys/hashing | `gateway/src/security/apikeys.js`, `gateway/src/db/database.js` (`authenticate`, `getSession`) |
| encryption at rest | `gateway/src/security/secretbox.js` |
| SSRF | `gateway/src/security/ssrf.js` |
| auth/CSRF/roles | `gateway/src/http/middleware.js`, `gateway/src/routes/auth.js` |
| routing + policy + audit | `gateway/src/gateway/service.js` |
| upstream connections, timeouts, cache | `gateway/src/gateway/upstreams.js` |
| MCP endpoint | `gateway/src/gateway/mcpEndpoint.js` |
| chat loop | `gateway/src/chat/agent.js`, `gateway/src/chat/providers.js` |
| WooCommerce tools | `woo-mcp/src/tools.js`, `woo-mcp/src/wc.js` |
| chart | `charts/urumi/templates/` (`networkpolicy.yaml`, `secrets.yaml`, `gateway.yaml`) |
| e2e | `e2e/run.mjs`, `e2e/sabotage.sh` |
