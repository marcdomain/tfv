{{- define "teriac.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Names every resource. Upgrading from the teriac-server chart: set nameOverride: teriac-server
     and fullnameOverride to the old name, so the StatefulSet and its disk are kept. */}}
{{- define "teriac.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "teriac.selectorLabels" -}}
app.kubernetes.io/name: {{ include "teriac.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "teriac.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "teriac.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "teriac.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "teriac.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "teriac.githubSecretName" -}}
{{- default (printf "%s-github" (include "teriac.fullname" .)) .Values.github.existingSecret -}}
{{- end -}}

{{- define "teriac.publicUrl" -}}
{{- if .Values.config.publicUrl -}}
{{- .Values.config.publicUrl -}}
{{- else if and .Values.httpRoute.enabled .Values.httpRoute.hostnames -}}
{{- printf "https://%s" (index .Values.httpRoute.hostnames 0) -}}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts -}}
{{- printf "%s://%s" (ternary "https" "http" (gt (len .Values.ingress.tls) 0)) (index .Values.ingress.hosts 0).host -}}
{{- end -}}
{{- end -}}

{{- define "teriac.validate" -}}
{{- if not .Values.github.appId -}}
{{- fail "github.appId is required" -}}
{{- end -}}
{{- if and (not .Values.github.existingSecret) (or (not .Values.github.privateKey) (not .Values.github.webhookSecret)) -}}
{{- fail "set github.existingSecret, or both github.privateKey and github.webhookSecret" -}}
{{- end -}}
{{- if and .Values.dashboard.oidc.enabled (or (not .Values.dashboard.oidc.issuer) (not .Values.dashboard.oidc.clientId)) -}}
{{- fail "dashboard.oidc needs issuer and clientId" -}}
{{- end -}}
{{- if and .Values.dashboard.oidc.enabled (not .Values.dashboard.oidc.existingSecret) (not .Values.dashboard.oidc.clientSecret) -}}
{{- fail "dashboard.oidc needs existingSecret or clientSecret" -}}
{{- end -}}
{{- if and .Values.dashboard.oidc.enabled (not (include "teriac.publicUrl" .)) -}}
{{- fail "dashboard.oidc needs a public URL for its redirect: set config.publicUrl, httpRoute.hostnames or ingress.hosts" -}}
{{- end -}}
{{- if and .Values.httpRoute.enabled (not .Values.httpRoute.parentRefs) -}}
{{- fail "httpRoute.parentRefs must name your Gateway" -}}
{{- end -}}
{{- if and (not .Values.config.repoAllowlist) (not .Values.repos.repos) -}}
{{- fail "allow at least one repo: config.repoAllowlist or repos.repos" -}}
{{- end -}}
{{- end -}}

{{- define "teriac.authSecretName" -}}
{{- printf "%s-auth" (include "teriac.fullname" .) -}}
{{- end -}}
