# tfv server

Pull request automation for **Terraform, OpenTofu and Terragrunt**, self-hosted with Docker or
the [Helm chart](../../charts/tfv-server/README.md).

On every push it does three things:
1. Finds the affected projects with no config needed.
2. Plans each one with the exact tool version it pins.
3. Keeps one PR comment up to date, plus a check run per project with an **Apply** button.

Every action goes through per-project permissions and required approvers taken from your Git
platform's users and teams. Scheduled drift checks post to Slack, Teams, Discord, Google Chat or
any webhook, and tag who last changed each resource.

## Quick start

```sh
docker run -p 8080:8080 -v tfv-data:/data \
  -e TFV_GITHUB_APP_ID=123456 \
  -e TFV_GITHUB_PRIVATE_KEY_FILE=/run/secrets/app.pem \
  -e TFV_GITHUB_WEBHOOK_SECRET_FILE=/run/secrets/webhook \
  -e TFV_REPO_ALLOWLIST='github.com/acme/*' \
  ghcr.io/marcdomain/tfv-server
```

Set up the GitHub App like this:
- **Webhook URL:** `https://<host>/events/github`
- **Events:** pull request, issue comment, check run
- **Permissions:** Checks (read & write), Contents (read), Issues (read & write), Pull requests
  (read & write), Members (read)

## PR commands

| Comment | Does |
|---|---|
| `tfv plan` | Plan every project this PR changes |
| `tfv plan -p <project>` | Plan one project. `-d <dir>` and `-w <workspace>` also work |
| `tfv plan -p <project> -t <address>` | Plan only some resources; repeat `-t` for more |
| `tfv plan --destroy` | Plan a destroy |
| `tfv apply` | Apply every ready project (can be turned off, see below) |
| `tfv apply -p <project>` | Apply one project. The Apply button does the same |
| `tfv unlock` | Release this PR's locks and drop its plans |

Apply always uses the saved plan, so what runs is exactly what was reviewed. `atlantis …`
commands also work.

## Settings

| Env var | Default | |
|---|---|---|
| `TFV_REQUIRE_APPLY_PROJECT` | `false` | `true` turns off a bare `tfv apply`; people must apply one project at a time with `-p` |
| `TFV_REPO_ALLOWLIST` | | Allowed repos, e.g. `github.com/acme/*` (or list them in `repos.yaml`) |
| `TFV_REPOS_CONFIG` | `/data/repos.yaml` | Rules, approvers, channels, drift schedules |
| `TFV_PARALLELISM` | `4` | Plans running at once |
| `TFV_DEFAULT_VERSION` | `latest` | Tool version when a project pins none |
| `TFV_PREINSTALL` | | Warm the cache, e.g. `terraform@1.9.8,tofu@1.8.5` |
| `TFV_DRIFT` | `true` | Run drift schedules |
| `TFV_SESSION_SECRET` | random | Signs dashboard sessions (32+ characters). Set it, or sessions end on restart |
| `TFV_API_TOKEN` | | Admin token for automation and `/api` |

`TFV_*` values are never passed to Terraform. Each secret can also be read from a file:
`<NAME>_FILE`.

## Rules: `repos.yaml`

```yaml
repos:
  - id: github.com/acme/*
    require_apply_project: true          # same as the env var, per repo
    apply_requirements: [mergeable]
    projects:
      - match: prod/**
        permissions:
          apply: [team:platform-admins]  # read|write|maintain|admin, team:x, user:x, codeowners, anyone
          apply_destroy: [admin]         # plans that delete or replace
        approvals:
          - { from: team:platform-admins, count: 2 }
          - { from: team:security, count: 1 }
      - match: "**"
        approvals: [{ from: write, count: 1 }]
```

Defaults when no rule applies:
- `plan` and `apply` need write access.
- Destroying plans and unlocking need maintain.

Only approvals of the current commit count, and the author's own approval never counts. Each
project needs only its own approvals.

A repo's `tfv.yaml` can name projects, pin versions, and add stricter rules, but never looser
ones. It's read from the base branch, so a PR can't change its own rules. `atlantis.yaml` works
too.

## Drift checks

```yaml
channels:                                # in repos.yaml; secrets stay in env vars
  infra-alerts: { type: slack, channel: "#infra-drift", token_env: TFV_SLACK_TOKEN }
  ops-teams:    { type: teams, webhook_url_env: TFV_TEAMS_WEBHOOK }
people:                                  # optional: git/GitHub → chat identity
  - { name: Bob Martins, github: bob-m, slack: U04BOBM, teams: bob@acme.onmicrosoft.com }

repos:
  - id: github.com/acme/infra
    drift:                               # or under `drift:` in the repo's tfv.yaml
      - name: prod-nightly
        projects: ["envs/prod", "live/prod/**"]
        branch: main
        schedule: "0 6 * * 1-5"
        timezone: Europe/Berlin
        notify: [infra-alerts, ops-teams]
```

Each run checks the branch with read-only plans (`-refresh-only -lock=false`) and reports:
- changes made outside Terraform;
- changes that were merged but never applied.

Each drifted resource tags the last person who changed its code, found from the git history of
its block, plus the last person who applied that project. Matching to chat users uses `people`
or Slack's lookup by email.

A message goes out only when the findings change (`notify_when: always` sends one every run).
Failed checks always notify.

## Dashboard

Open the server's URL in a browser. It shows:
- an overview of runs, failures, locks and drift;
- every plan and apply, with its change list and redacted log;
- locks, with an Unlock button;
- drift schedules, findings, and who last changed each resource;
- the audit log.

It has light and dark themes. Viewers can see everything; admins can also unlock and start drift
checks.

| Sign-in | Settings |
|---|---|
| Okta or any OIDC provider | `TFV_OIDC_ISSUER`, `TFV_OIDC_CLIENT_ID`, `TFV_OIDC_CLIENT_SECRET`, `TFV_OIDC_ADMIN_GROUPS`, `TFV_OIDC_ALLOWED_GROUPS`. Redirect URI: `<public url>/auth/oidc/callback` |
| Username and password | `dashboard.users` in `repos.yaml`, or `TFV_DASHBOARD_USERS_FILE`. Hash passwords with `node packages/server/src/hash-password.ts` |
| API token | `TFV_API_TOKEN` (admin) |

Sessions are signed, HttpOnly cookies. Login attempts are rate limited, and the page loads nothing
from third parties.

## API

These need a dashboard session or `Authorization: Bearer $TFV_API_TOKEN`:
- `GET /api/runs`
- `GET /api/locks`
- `GET /api/audit`
- `GET /api/drift`
- `GET /api/drift/schedules`
- `POST /api/drift/run?key=…` (admin)
- `POST /api/locks/unlock` (admin)

`/healthz`, `/readyz` and `/metrics` (Prometheus) are open.
