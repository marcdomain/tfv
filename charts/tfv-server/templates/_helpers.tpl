{{- define "tfv.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tfv.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "tfv.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tfv.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "tfv.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "tfv.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "tfv.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "tfv.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "tfv.githubSecretName" -}}
{{- default (printf "%s-github" (include "tfv.fullname" .)) .Values.github.existingSecret -}}
{{- end -}}

{{- define "tfv.publicUrl" -}}
{{- if .Values.config.publicUrl -}}
{{- .Values.config.publicUrl -}}
{{- else if and .Values.ingress.enabled .Values.ingress.hosts -}}
{{- printf "%s://%s" (ternary "https" "http" (gt (len .Values.ingress.tls) 0)) (index .Values.ingress.hosts 0).host -}}
{{- end -}}
{{- end -}}

{{- define "tfv.validate" -}}
{{- if not .Values.github.appId -}}
{{- fail "github.appId is required" -}}
{{- end -}}
{{- if and (not .Values.github.existingSecret) (or (not .Values.github.privateKey) (not .Values.github.webhookSecret)) -}}
{{- fail "set github.existingSecret, or both github.privateKey and github.webhookSecret" -}}
{{- end -}}
{{- if and (not .Values.config.repoAllowlist) (not .Values.repos.repos) -}}
{{- fail "allow at least one repo: config.repoAllowlist or repos.repos" -}}
{{- end -}}
{{- end -}}
