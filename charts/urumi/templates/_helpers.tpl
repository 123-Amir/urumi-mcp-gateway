{{/* ---- names ---- */}}
{{- define "urumi.fullname" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "urumi.storeHost" -}}
{{- if and (not .Values.global.storeHost) (not .Values.global.domain) -}}{{- fail "set global.domain (or global.storeHost / global.dashboardHost)" -}}{{- end -}}
{{- if eq .Values.global.domain "example.com" -}}{{- fail "global.domain is still the placeholder example.com: set your real domain" -}}{{- end -}}
{{- default (printf "shop.%s" .Values.global.domain) .Values.global.storeHost -}}
{{- end -}}

{{- define "urumi.dashboardHost" -}}
{{- default (printf "dashboard.%s" .Values.global.domain) .Values.global.dashboardHost -}}
{{- end -}}

{{- define "urumi.storeUrl" -}}
{{- printf "%s://%s" .Values.global.scheme (include "urumi.storeHost" .) -}}
{{- end -}}

{{- define "urumi.dashboardUrl" -}}
{{- printf "%s://%s" .Values.global.scheme (include "urumi.dashboardHost" .) -}}
{{- end -}}

{{/* in-cluster service FQDN: <fullname>-<component>.<namespace>.svc.cluster.local */}}
{{- define "urumi.svcHost" -}}
{{- printf "%s-%s.%s.svc.cluster.local" (include "urumi.fullname" .root) .component .root.Release.Namespace -}}
{{- end -}}

{{- define "urumi.secretName" -}}
{{- if .Values.secrets.existingSecret -}}{{ .Values.secrets.existingSecret }}{{- else -}}{{ include "urumi.fullname" . }}-secrets{{- end -}}
{{- end -}}

{{- define "urumi.image" -}}
{{- printf "%s:%s" .repository (.tag | toString) -}}
{{- end -}}

{{/* ---- labels. call: include "urumi.labels" (dict "root" . "component" "gateway") ---- */}}
{{- define "urumi.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/part-of: urumi-mcp-platform
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- end -}}

{{- define "urumi.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* ---- security contexts: every workload is locked down unless a template says (and documents) otherwise ---- */}}
{{- define "urumi.podSecurity" -}}
runAsNonRoot: true
runAsUser: {{ .uid }}
runAsGroup: {{ .uid }}
fsGroup: {{ .uid }}
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "urumi.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* ---- env var from the Secret. call: include "urumi.secretEnv" (dict "root" . "name" "X" "key" "X") ---- */}}
{{- define "urumi.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ include "urumi.secretName" .root }}
      key: {{ .key }}
{{- if .optional }}
      optional: true
{{- end }}
{{- end -}}

{{/* ---- secret value resolution: explicit value > value already in the cluster > freshly generated ---- */}}
{{- define "urumi.plain" -}}
{{- if .override -}}{{ .override }}{{- else if (get .old .key) -}}{{ get .old .key | b64dec }}{{- else -}}{{ .gen }}{{- end -}}
{{- end -}}

{{/* ---- env blocks (rendered as YAML text and spliced into the workload) ---- */}}
{{- define "urumi.wooEnv" -}}
- name: WC_BASE_URL
  value: http://{{ include "urumi.fullname" . }}-wordpress:80
- name: WC_FORWARD_HTTPS
  value: "true"
- name: WC_TIMEZONE
  value: {{ .Values.store.timezone | quote }}
- name: WC_TIMEOUT_MS
  value: "10000"
{{ include "urumi.secretEnv" (dict "root" . "name" "WC_CONSUMER_KEY" "key" "WC_CONSUMER_KEY") }}
{{ include "urumi.secretEnv" (dict "root" . "name" "WC_CONSUMER_SECRET" "key" "WC_CONSUMER_SECRET") }}
{{ include "urumi.secretEnv" (dict "root" . "name" "MCP_AUTH_TOKEN" "key" "WOO_MCP_TOKEN") }}
{{- end -}}

{{- define "urumi.demoEnv" -}}
- name: MODE
  value: {{ .mode }}
{{ include "urumi.secretEnv" (dict "root" .root "name" "MCP_AUTH_TOKEN" "key" .tokenKey) }}
{{- end -}}
