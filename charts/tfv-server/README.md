# tfv-server Helm chart

Runs [tfv server](../../packages/server/README.md) on Kubernetes. It's pull request automation
for Terraform, OpenTofu and Terragrunt, with per-project RBAC, required approvers and drift
alerts.

## Install

```sh
kubectl create namespace tfv
kubectl -n tfv create secret generic tfv-github \
  --from-file=private-key=app.pem \
  --from-literal=webhook-secret="$WEBHOOK_SECRET"

helm install tfv oci://ghcr.io/marcdomain/charts/tfv-server -n tfv \
  --set github.appId=123456 \
  --set github.existingSecret=tfv-github \
  --set 'config.repoAllowlist={github.com/acme/*}' \
  --set ingress.enabled=true --set 'ingress.hosts[0].host=tfv.acme.dev' \
  --set 'ingress.hosts[0].paths[0].path=/' --set 'ingress.hosts[0].paths[0].pathType=Prefix'
```

Then point the GitHub App's webhook at `https://tfv.acme.dev/events/github`. Run `helm test tfv -n tfv`
to check the install.

## Common values

| Value | Default | |
|---|---|---|
| `github.appId` | | **Required.** GitHub App ID |
| `github.existingSecret` | | Secret with `private-key` and `webhook-secret`. Or set `github.privateKey` and `github.webhookSecret` to have the chart create it |
| `github.apiUrl` | | GitHub Enterprise Server API URL |
| `config.repoAllowlist` | `[]` | Repos tfv may act on, e.g. `github.com/acme/*` |
| `config.requireApplyProject` | `false` | `true` refuses a bare `tfv apply`; one project at a time with `-p` |
| `config.parallelism` | `4` | Plans running at once |
| `config.defaultVersion` | `latest` | Tool version when a project pins none |
| `config.preinstall` | `[]` | e.g. `[terraform@1.9.8, tofu@1.8.5]` |
| `config.drift` | `true` | Run drift schedules |
| `repos` | `{}` | Full `repos.yaml`: rules, approvers, channels, people, drift schedules |
| `extraEnvFrom` / `extraEnv` | `[]` | Cloud credentials, `TFV_SLACK_TOKEN`, `TFV_TEAMS_WEBHOOK`, … |
| `serviceAccount.annotations` | `{}` | Workload identity: IRSA, GKE, Azure |
| `persistence.size` | `20Gi` | Checkouts, saved plans, binaries, provider cache, database |
| `ingress.*` | off | Expose `/events/github` |
| `serviceMonitor.enabled` | `false` | Prometheus scraping of `/metrics` |
| `podDisruptionBudget.enabled` | `false` | Stop node drains from interrupting an apply |
| `networkPolicy.enabled` | `false` | Allow inbound traffic only from `networkPolicy.ingressFrom` |

## Rules in values

```yaml
config:
  requireApplyProject: true
repos:
  channels:
    infra-alerts: { type: slack, channel: "#infra-drift", token_env: TFV_SLACK_TOKEN }
  repos:
    - id: github.com/acme/infra
      projects:
        - match: prod/**
          permissions: { apply: [team:platform-admins], apply_destroy: [admin] }
          approvals: [{ from: team:platform-admins, count: 2 }]
      drift:
        - { name: prod-nightly, projects: ["prod/**"], schedule: "0 6 * * 1-5", timezone: Europe/Berlin, notify: [infra-alerts] }
extraEnvFrom:
  - secretRef: { name: tfv-chat-tokens }   # holds TFV_SLACK_TOKEN
```

## How it runs

- **One replica, as a StatefulSet.** Locks and run history are kept in SQLite on the volume.
- **Locked down by default.** It runs as non-root (uid 10001) with a read-only root filesystem,
  all Linux capabilities dropped, and the `RuntimeDefault` seccomp profile.
- **Applies finish before shutdown.** `terminationGracePeriodSeconds: 3600` lets a running apply
  finish on upgrades. Lower it if your applies are short.
- **Config changes roll the pod.** Checksums of the config and secret are pod annotations.
