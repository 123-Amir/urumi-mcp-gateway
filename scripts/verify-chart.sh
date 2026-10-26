#!/usr/bin/env bash
# Static verification of the Helm chart. Works WITHOUT a cluster.
#   real helm present  -> `helm lint` + `helm template` (authoritative)
#   no helm            -> charts/tools/minihelm.py (a small Helm-subset renderer; a stand-in, NOT Helm)
# then: kubeconform (Kubernetes schemas) if installed, policy/cross-reference checks, and a mutation test proving the checker can fail.
set -euo pipefail
cd "$(dirname "$0")/../charts"
OUT="$(mktemp -d)"; fail=0
render() { # render <name> <values-file> [extra helm --set args...]
  local name=$1 vf=$2; shift 2
  if command -v helm >/dev/null; then
    helm lint urumi -f "urumi/$vf" "$@" >/dev/null; mkdir -p "$OUT/$name"
    helm template urumi urumi -n urumi -f "urumi/$vf" "$@" --output-dir "$OUT/$name.raw" >/dev/null
    find "$OUT/$name.raw" -name '*.yaml' -exec cp {} "$OUT/$name/" \;
  else python3 tools/minihelm.py urumi "$OUT/$name" -f "urumi/$vf" "$@" >/dev/null; fi
}
render local values-local.yaml
render prod  values-prod.yaml --set global.domain=prod.test --set gateway.llm.model=check
for n in local prod; do
  if command -v kubeconform >/dev/null; then kubeconform -strict -summary -kubernetes-version 1.31.0 -ignore-filename-pattern NOTES "$OUT/$n"/*.yaml || fail=1; fi
done
python3 tools/check_manifests.py "$OUT/local" || fail=1
python3 tools/check_manifests.py "$OUT/prod" --existing-secret || fail=1
python3 tools/test_checker.py "$OUT/local" | tail -1 || fail=1
command -v helm >/dev/null || echo "NOTE: real helm not found; rendered with minihelm (stand-in). Run again where helm is installed."
exit $fail
