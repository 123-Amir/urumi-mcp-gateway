#!/usr/bin/env bash
# Create the production Secret OUT OF BAND (so secret values never enter Helm's release history). Idempotent: refuses to overwrite.
#   NS=urumi RELEASE=urumi scripts/create-prod-secrets.sh            (optional: OPENAI_API_KEY=sk-... to enable the real LLM)
set -euo pipefail
NS="${NS:-urumi}"; RELEASE="${RELEASE:-urumi}"; NAME="${SECRET_NAME:-urumi-secrets}"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
if kubectl -n "$NS" get secret "$NAME" >/dev/null 2>&1; then echo "secret $NAME already exists in $NS: not touching it (rotate deliberately, see docs)"; exit 0; fi
rnd() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
WOO=$(rnd 40); UTILS=$(rnd 40); NOTES=$(rnd 40)
HOST() { echo "http://${RELEASE}-$1.${NS}.svc.cluster.local:3000/mcp"; }
SEED=$(printf '[{"slug":"woo","name":"WooCommerce","url":"%s","authType":"bearer","credential":"%s"},{"slug":"utils","name":"Utilities (demo)","url":"%s","authType":"bearer","credential":"%s"},{"slug":"notes","name":"Notes (demo)","url":"%s","authType":"bearer","credential":"%s"}]' \
  "$(HOST woo-mcp)" "$WOO" "$(HOST demo-utils)" "$UTILS" "$(HOST demo-notes)" "$NOTES")
kubectl -n "$NS" create secret generic "$NAME" \
  --from-literal=MARIADB_ROOT_PASSWORD="$(rnd 28)" --from-literal=MARIADB_PASSWORD="$(rnd 28)" \
  --from-literal=WORDPRESS_ADMIN_PASSWORD="$(rnd 20)" \
  --from-literal=WC_CONSUMER_KEY="ck_$(rnd 40)" --from-literal=WC_CONSUMER_SECRET="cs_$(rnd 40)" \
  --from-literal=WOO_MCP_TOKEN="$WOO" --from-literal=UTILS_MCP_TOKEN="$UTILS" --from-literal=NOTES_MCP_TOKEN="$NOTES" \
  --from-literal=GATEWAY_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  --from-literal=BOOTSTRAP_ADMIN_API_KEY="umk_$(rnd 8)_$(rnd 43)" \
  --from-literal=SEED_SERVERS_JSON="$SEED" --from-literal=OPENAI_API_KEY="${OPENAI_API_KEY:-}"
echo "created secret $NAME in namespace $NS. BACK UP GATEWAY_ENCRYPTION_KEY: without it stored upstream credentials cannot be decrypted."
