#!/usr/bin/env bash
# Post-install smoke + isolation checks against a RUNNING cluster. Needs kubectl + curl. Prints PASS/FAIL per check, exit 1 on any failure.
set -uo pipefail
NS="${NS:-urumi}"; REL="${RELEASE:-urumi}"; SECRET="${SECRET_NAME:-$REL-secrets}"
DOMAIN="${DOMAIN:-localtest.me}"; SCHEME="${SCHEME:-http}"
STORE="$SCHEME://shop.$DOMAIN"; DASH="$SCHEME://dashboard.$DOMAIN"
fail=0; ok() { echo "PASS  $*"; }; bad() { echo "FAIL  $*"; fail=1; }
code() { curl -s -o /dev/null -m 8 -w '%{http_code}' "$@"; }
secret() { kubectl -n "$NS" get secret "$SECRET" -o "jsonpath={.data.$1}" | base64 -d; }

echo "== workloads ready"
for d in wordpress woo-mcp demo-utils demo-notes gateway dashboard; do
  kubectl -n "$NS" rollout status "deploy/$REL-$d" --timeout=120s >/dev/null 2>&1 && ok "deploy/$REL-$d ready" || bad "deploy/$REL-$d not ready"; done
kubectl -n "$NS" rollout status "statefulset/$REL-mariadb" --timeout=120s >/dev/null 2>&1 && ok "mariadb ready" || bad "mariadb not ready"

echo "== public endpoints"
c=$(code "$STORE/"); [[ "$c" =~ ^(200|301|302)$ ]] && ok "storefront $c" || bad "storefront $c"
c=$(code "$STORE/wp-json/wc/v3/products"); [ "$c" = 401 ] && ok "WooCommerce REST requires auth (401 without keys)" || bad "REST unauthenticated returned $c (expected 401)"
c=$(code "$DASH/"); [ "$c" = 200 ] && ok "dashboard $c" || bad "dashboard $c"
c=$(code "$DASH/api/servers"); [ "$c" = 401 ] && ok "API requires auth ($c)" || bad "API unauthenticated returned $c"
c=$(code -X POST "$DASH/mcp" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{}'); [ "$c" = 401 ] && ok "/mcp requires a key ($c)" || bad "/mcp unauthenticated returned $c"

echo "== gateway sees all three upstreams (uses the bootstrap admin key from the cluster Secret; key never printed)"
KEY=$(secret BOOTSTRAP_ADMIN_API_KEY)
out=$(curl -s -m 15 -X POST "$DASH/api/auth/login" -H 'content-type: application/json' -H "origin: $DASH" -c /tmp/urumi-smoke.jar -d "{\"apiKey\":\"$KEY\"}")
echo "$out" | grep -q '"role":"admin"' && ok "admin login works" || bad "admin login failed"
servers=$(curl -s -m 15 -b /tmp/urumi-smoke.jar "$DASH/api/servers")
for s in woo utils notes; do echo "$servers" | grep -q "\"slug\":\"$s\"" && ok "server '$s' registered" || bad "server '$s' missing"; done
echo "$servers" | grep -q 'credential' && bad "API response mentions 'credential' fields" || ok "no credential material in /api/servers"
rm -f /tmp/urumi-smoke.jar

echo "== NetworkPolicy isolation (needs a CNI that enforces policy: Calico/Cilium/k3s)"
run_probe() { # run_probe <labels> <shell command run inside a throw-away busybox pod>; exit status 0 = the command succeeded
  kubectl -n "$NS" run "np-probe-$RANDOM" --rm -i --restart=Never --quiet --image=busybox:1.36 --labels="$1" --command -- sh -c "$2" >/dev/null 2>&1; }
# HTTP services: wget succeeds only on a real HTTP answer.  MariaDB speaks the MySQL protocol, so test the TCP connect itself with nc
# (a wget against it would fail EVEN WHEN reachable and give a false "blocked").
run_probe "app=stranger" "wget -q -T 4 -O- http://$REL-woo-mcp:3000/healthz" && bad "an unrelated pod CAN reach woo-mcp" || ok "unrelated pod cannot reach woo-mcp"
run_probe "app=stranger" "nc -w 4 $REL-mariadb 3306 </dev/null" && bad "an unrelated pod CAN reach mariadb" || ok "unrelated pod cannot reach mariadb"
run_probe "app=stranger" "wget -q -T 4 -O- http://$REL-demo-utils:3000/healthz" && bad "an unrelated pod CAN reach demo-utils" || ok "unrelated pod cannot reach demo-utils"
GW=$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=gateway -o name | head -1)
kubectl -n "$NS" exec "$GW" -- node -e "fetch('http://$REL-woo-mcp.$NS.svc.cluster.local:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
  && ok "gateway CAN reach woo-mcp" || bad "gateway cannot reach woo-mcp"
kubectl -n "$NS" exec "$GW" -- node -e "fetch('http://$REL-mariadb:3306',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(1)).catch(e=>process.exit(e.name==='TimeoutError'?0:1))" \
  && ok "gateway cannot reach mariadb (blocked: timeout)" || bad "gateway reached mariadb or errored differently"
exit $fail
