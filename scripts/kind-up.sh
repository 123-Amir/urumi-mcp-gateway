#!/usr/bin/env bash
# Create the local cluster: kind + Calico (NetworkPolicy enforcement) + ingress-nginx. Needs: docker, kind, kubectl.
set -euo pipefail
cd "$(dirname "$0")/.."
CALICO=https://raw.githubusercontent.com/projectcalico/calico/v3.29.1/manifests/calico.yaml
INGRESS=https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.0/deploy/static/provider/kind/deploy.yaml

kind get clusters | grep -qx urumi || kind create cluster --config deploy/kind-config.yaml
kubectl config use-context kind-urumi

kubectl apply -f "$CALICO"
# kind runs nodes as containers; Calico's reverse-path check trips on that. Documented kind+Calico workaround:
kubectl -n kube-system set env daemonset/calico-node FELIX_IGNORELOOSERPF=true
kubectl -n kube-system rollout status daemonset/calico-node --timeout=300s
kubectl wait --for=condition=Ready nodes --all --timeout=300s

kubectl apply -f "$INGRESS"
kubectl -n ingress-nginx wait --for=condition=Ready pod -l app.kubernetes.io/component=controller --timeout=300s
echo "cluster ready. next: scripts/build-images.sh && scripts/install-local.sh"
echo "k3d alternative (k3s enforces NetworkPolicy out of the box, ships Traefik):"
echo "  k3d cluster create urumi -p '80:80@loadbalancer' && scripts/install-local.sh --set ingress.className=traefik --set networkPolicy.ingressControllerNamespace=kube-system --set ingress.gatewayAnnotations=null"
