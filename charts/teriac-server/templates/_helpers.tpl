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
{{- include "teriac.validateBackup" . -}}
{{- end -}}

{{/* The backup backend: the one of backup.backend.s3, .gcs or .azure that names a bucket (container). */}}
{{- define "teriac.backupType" -}}
{{- $d := .Values.backup.backend | default dict -}}
{{- $set := list -}}
{{- if (($d.s3 | default dict).bucket) }}{{ $set = append $set "s3" }}{{ end -}}
{{- if (($d.gcs | default dict).bucket) }}{{ $set = append $set "gcs" }}{{ end -}}
{{- if (($d.azure | default dict).container) }}{{ $set = append $set "azure" }}{{ end -}}
{{- join "," $set -}}
{{- end -}}

{{/* Backup settings, checked at install so mistakes don't surface as a failed backup at 3am. */}}
{{- define "teriac.validateBackup" -}}
{{- $b := .Values.backup -}}
{{- if $b.enabled -}}
{{- $d := $b.backend -}}
{{- if or (not (kindIs "map" $d)) $d.type $d.bucket -}}
{{- fail "backup.backend: fill in one section with its bucket: backup.backend.s3.bucket, backup.backend.gcs.bucket, or backup.backend.azure.container (with accountName)" -}}
{{- end -}}
{{- $schedule := regexReplaceAll "\\s+" (trim (toString $b.schedule)) " " -}}
{{- if not $schedule -}}
{{- fail "backup.schedule is required when backup.enabled is true (cron, e.g. \"0 3 * * *\")" -}}
{{- end -}}
{{- if ne (len (splitList " " $schedule)) 5 -}}
{{- fail (printf "backup.schedule %q must be a cron expression with 5 fields: minute hour day month weekday, e.g. \"0 3 * * *\"" $b.schedule) -}}
{{- end -}}
{{- $type := include "teriac.backupType" . -}}
{{- if not $type -}}
{{- fail "backup.enabled is true but no backend is set: fill in backup.backend.s3.bucket, backup.backend.gcs.bucket, or backup.backend.azure.container" -}}
{{- end -}}
{{- if contains "," $type -}}
{{- fail (printf "backup.backend: set only one of s3, gcs or azure (found %s)" (replace "," ", " $type)) -}}
{{- end -}}
{{- $sec := index $d $type -}}
{{- $bucket := ternary $sec.container $sec.bucket (eq $type "azure") -}}
{{- if contains "/" $bucket -}}
{{- fail (printf "backup.backend.%s.%s %q must be the name only; put folders in backup.backend.%s.path" $type (ternary "container" "bucket" (eq $type "azure")) $bucket $type) -}}
{{- end -}}
{{- if or (contains ".." (toString $sec.path)) (contains "//" (toString $sec.path)) -}}
{{- fail (printf "backup.backend.%s.path %q may not contain \"..\" or empty folders" $type (toString $sec.path)) -}}
{{- end -}}
{{- if and (eq $type "azure") (not $sec.accountName) -}}
{{- fail "backup.backend.azure.accountName is required with backup.backend.azure.container" -}}
{{- end -}}
{{- if and (eq $type "s3") $sec.endpoint (not (regexMatch "^https?://" $sec.endpoint)) -}}
{{- fail (printf "backup.backend.s3.endpoint %q must start with https:// or http://" $sec.endpoint) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "teriac.authSecretName" -}}
{{- printf "%s-auth" (include "teriac.fullname" .) -}}
{{- end -}}
