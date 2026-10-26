#!/usr/bin/env bash
# Build the four application images. LOCAL: also load them into the kind nodes (no registry needed).
# PROD:  REGISTRY=registry.example.com/urumi PUSH=1 scripts/build-images.sh
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${TAG:-0.1.0}"; REGISTRY="${REGISTRY:-urumi}"
for svc in gateway woo-mcp demo-mcp dashboard; do
  docker build -t "$REGISTRY/$svc:$TAG" "$svc/"
  if [ "${PUSH:-0}" = "1" ]; then docker push "$REGISTRY/$svc:$TAG"
  elif kind get clusters 2>/dev/null | grep -qx urumi; then kind load docker-image "$REGISTRY/$svc:$TAG" --name urumi; fi
done
echo "built $REGISTRY/{gateway,woo-mcp,demo-mcp,dashboard}:$TAG"
