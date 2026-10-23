# Convenience targets. Needs: node >= 22.13, python3. (kubeconform/helm optional for chart-verify.)
.PHONY: install test e2e e2e-sabotage chart-verify docs-check all
install:            ; for d in gateway woo-mcp demo-mcp dashboard; do (cd $$d && npm ci); done
test:               ; for d in gateway woo-mcp demo-mcp dashboard; do (cd $$d && npm test) || exit 1; done
e2e:                ; node --disable-warning=ExperimentalWarning e2e/run.mjs
e2e-sabotage:       ; bash e2e/sabotage.sh
chart-verify:       ; bash scripts/verify-chart.sh
docs-check:         ; python3 docs/check_docs.py --run-tests
all: test e2e chart-verify docs-check
