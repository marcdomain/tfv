# tfv server

Pull request automation for **Terraform, OpenTofu and Terragrunt**, self-hosted with Docker or
the [Helm chart](../../charts/tfv-server/README.md).

On every push it does three things:
1. Finds the affected projects with no config needed.
2. Plans each one with the exact tool version it pins.
3. Posts the plan as a new comment, showing the exact command to apply each project, plus a check run per project with an **Apply** button.

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
- **Logo:** upload [`docs/tfv-logo.png`](docs/tfv-logo.png) under *Display information*.
  Without a logo, GitHub shows the App owner's picture on tfv's comments.

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

Apply always uses the saved plan, so what runs is exactly what was reviewed.

## Settings

| Env var | Default | |
|---|---|---|
| `TFV_REQUIRE_APPLY_PROJECT` | `false` | `true` turns off a bare `tfv apply`; people must apply one project at a time with `-p` |
| `TFV_REPO_ALLOWLIST` | | Allowed repos, e.g. `github.com/acme/*` (or list them in `repos.yaml`) |
| `TFV_REPOS_CONFIG` | `/data/repos.yaml` | Rules, approvers, channels, drift schedules |
| `TFV_ACK_REACTION` | `eyes` | Reaction on a command tfv picked up: `eyes`, `rocket`, `+1`, `heart`, `hooray`, `laugh`, `confused`, `-1` or `none`. Per repo: `ack_reaction` |
| `TFV_PROGRESS_REPLY` | `false` | Off: each result is posted once, as a new comment, and never edited (👀 shows it was picked up). On: a spinning "Running…" reply that is edited into the result. Needs a public https `TFV_PUBLIC_URL`; skipped otherwise. Per repo: `progress_reply` |
| `TFV_COMMENT_MODE` | `new` | `new`: each plan and apply gets its own comment under the command. `update`: one comment at the top, edited in place. Per repo: `comment_mode` |
| `TFV_PARALLELISM` | `4` | Plans and applies running at once, across all PRs |
| `TFV_PR_PARALLELISM` | parallelism − 1 | One PR's share, so other PRs always get a slot. Freed slots go to the PR with the fewest runs going |
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
ones. It's read from the base branch, so a PR can't change its own rules.

## What gets planned

tfv finds Terraform, OpenTofu and Terragrunt projects on its own and plans the ones a PR
affects. That includes changes to:
- the project's own files;
- modules it uses, and the modules those use;
- Terragrunt includes (such as `_envcommon`), `dependency` units, `read_terragrunt_config(...)`,
  `file(...)`, and hook scripts;
- parent `root.hcl`, `env.hcl` and version pins.

Paths built with Terragrunt functions (`get_repo_root()`, `get_terragrunt_dir()`,
`find_in_parent_folders()`) and with locals are resolved too.

**Watch extra files.** For a file no config mentions, such as source code that a build step
packages, add a watch. Globs work, a folder means everything inside it, and watches add to
automatic detection; they never replace it.

```hcl
# tfv:watch /lambda/orders/**/*.py scripts/build.sh      ← in any .tf, .tofu or .hcl file

locals {                                                ← Terragrunt, with its functions
  tfv_watch = ["${get_repo_root()}/schemas/*.json"]
}
```

```yaml
# tfv.yaml
projects:
  - dir: stacks/orders
    watch: ["/lambda/orders/**"]
```

Paths are relative to the project folder; a leading `/` means the repo root.

## Terragrunt dependencies

tfv never applies a dependency for you, and never applies a plan built on wrong outputs:
- **Mock outputs.** A unit planned with a dependency's `mock_outputs` (because the dependency
  isn't applied yet) is flagged in the PR and can't be applied, not even with `--override`.
  tfv tells you to apply the dependency first: `tfv apply -p live/prod/vpc`.
- **Re-plans.** When you apply a dependency, tfv re-plans the units that depend on it with the
  real outputs. That's a plan only, for you to review and apply.
- **Outdated plans.** A plan made before one of its dependencies was applied is refused with
  "re-plan first".
- **Order.** Several units applied in one command go in dependency order, and independent ones
  run in parallel.

## Policy checks

Rules run on every plan. In `audit` mode they report; in `enforce` mode they also block apply.
Only people in `override` can apply anyway, with `tfv apply -p <project> --override`. That is
audited.

```yaml
policies:                     # in repos.yaml (server side, so a PR can't change them)
  mode: enforce               # off | audit | enforce (a repo can only make it stricter)
  override: [team:security]
  rules:
    - name: no-public-s3
      resource: aws_s3_bucket_acl
      deny_if: { attribute: acl, in: [public-read, public-read-write] }
    - name: rds-encrypted
      resource: aws_db_instance
      require: { attribute: storage_encrypted, equals: true }
    - name: no-prod-destroy
      projects: ["prod/**"]
      actions: [delete, replace]
      message: Destroying in prod needs a security override
  commands:                   # any scanner; non-zero exit = finding
    - name: checkov
      run: [checkov, -f, "{plan_json}", --framework, terraform_plan, --compact, --quiet]
```

**Rule fields:**
- `resource`: a glob on the resource type.
- `actions`: `create`, `update`, `replace` or `delete`.
- `projects`: globs on the project.
- `deny_if`: a finding when the condition is true.
- `require`: a finding when the condition is false.
- Neither: the change itself is a finding.

**Conditions** check an `attribute` path with `equals`, `in`, `matches` (a regex) or `exists`.
Values only known after apply are skipped.

Findings appear in the PR comment, the check run and the dashboard's **Audit → Policy findings**
tab.

## Two-person rule

`two_person_rule: true` on a repo, or on a project rule in `repos.yaml`, means the PR's author
can't apply it; someone else with apply rights must.

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

## Tamper-proof output

GitHub lets anyone with write access edit any comment, including tfv's. tfv never reads its
comments back: what gets applied comes from the plan saved on the server, and check runs (which
users can't edit) and the dashboard are the trusted record. If someone edits or deletes a tfv
comment, tfv posts a warning naming who did it, with a link to the comment and a "View the
original" section, and logs it in the audit log.

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
