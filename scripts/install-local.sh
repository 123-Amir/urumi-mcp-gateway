#!/usr/bin/env bash
# Install/upgrade the chart on the local cluster. Extra args are passed to helm (e.g. --set gateway.llm.provider=openai ...).
set -euo pipefail
cd "$(dirname "$0")/.."
NS="${NS:-urumi}"; RELEASE="${RELEASE:-urumi}"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
# Pod Security Admission: baseline is enforced (WordPress needs a few capabilities, all within the baseline allow-list); restricted only warns.
kubectl label namespace "$NS" pod-security.kubernetes.io/enforce=baseline pod-security.kubernetes.io/warn=restricted --overwrite
helm upgrade --install "$RELEASE" charts/urumi -n "$NS" -f charts/urumi/values-local.yaml --wait --timeout 15m "$@"
