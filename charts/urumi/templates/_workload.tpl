{{/* A stateless, locked-down HTTP workload (non-root uid 10001, read-only root fs, no capabilities, /tmp as emptyDir).
     call: include "urumi.httpWorkload" (dict "root" . "component" "woo-mcp" "image" .Values.images.wooMcp "port" 3000 "replicas" 1
                                             "resources" ... "env" (list-of-env-yaml-string)) */}}
{{- define "urumi.httpWorkload" -}}
{{- $fn := include "urumi.fullname" .root }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $fn }}-{{ .component }}
  labels:
    {{- include "urumi.labels" (dict "root" .root "component" .component) | nindent 4 }}
spec:
  replicas: {{ .replicas }}
  selector:
    matchLabels:
      {{- include "urumi.selector" (dict "root" .root "component" .component) | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "urumi.labels" (dict "root" .root "component" .component) | nindent 8 }}
    spec:
      serviceAccountName: {{ $fn }}-{{ .component }}
      automountServiceAccountToken: false
      {{- with .root.Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      securityContext:
        {{- include "urumi.podSecurity" (dict "uid" 10001) | nindent 8 }}
      containers:
        - name: {{ .component }}
          image: {{ include "urumi.image" .image }}
          imagePullPolicy: {{ .root.Values.images.pullPolicy }}
          ports:
            - name: http
              containerPort: {{ .port }}
          env:
            - name: PORT
              value: {{ .port | quote }}
            {{- .env | nindent 12 }}
          securityContext:
            {{- include "urumi.containerSecurity" . | nindent 12 }}
          resources:
            {{- toYaml .resources | nindent 12 }}
          startupProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 2
            failureThreshold: 30
          readinessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 10
            timeoutSeconds: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
            periodSeconds: 20
            timeoutSeconds: 3
            failureThreshold: 3
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ $fn }}-{{ .component }}
  labels:
    {{- include "urumi.labels" (dict "root" .root "component" .component) | nindent 4 }}
spec:
  type: ClusterIP            # internal only: there is deliberately no Ingress for this component
  selector:
    {{- include "urumi.selector" (dict "root" .root "component" .component) | nindent 4 }}
  ports:
    - name: http
      port: {{ .port }}
      targetPort: http
{{- end -}}
