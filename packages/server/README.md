# teriac server

Pull request automation for **Terraform, OpenTofu and Terragrunt**, self-hosted with Docker or
the [Helm chart](../../charts/teriac-server/README.md).

On every push it does three things:
1. Finds the affected projects with no config needed.
2. Plans each one with the exact tool version it pins.
3. Posts the plan as a new comment, showing the exact command to apply each project, plus a check run per project with an **Apply** button.

Every action goes through per-project permissions and required approvers taken from your Git
platform's users and teams. Scheduled drift checks post to Slack, Teams, Discord, Google Chat or
any webhook, and tag who last changed each resource.

## Quick start

```sh
docker run -p 8080:8080 -v teriac-data:/data \
  -e TERIAC_GITHUB_APP_ID=123456 \
  -e TERIAC_GITHUB_PRIVATE_KEY_FILE=/run/secrets/app.pem \
  -e TERIAC_GITHUB_WEBHOOK_SECRET_FILE=/run/secrets/webhook \
  -e TERIAC_REPO_ALLOWLIST='github.com/acme/*' \
  ghcr.io/marcdomain/teriac-server
```

Set up the GitHub App like this:
- **Webhook URL:** `https://<host>/events/github`
- **Events:** pull request, issue comment, check run
- **Permissions:** Checks (read & write), Contents (read), Issues (read & write), Pull requests
  (read & write), Members (read)
- **Logo:** upload [`brand/teriac-avatar.png`](../../brand/teriac-avatar.png) under *Display information*.
  Without a logo, GitHub shows the App owner's picture on teriac's comments.

## PR commands

| Comment | Does |
|---|---|
| `teriac plan` | Plan every project this PR changes |
| `teriac plan -p <project>` | Plan one project. `-d <dir>` and `-w <workspace>` also work |
| `teriac plan -p <project> -t <address>` | Plan only some resources; repeat `-t` for more |
| `teriac plan --destroy` | Plan a destroy |
| `teriac plan -p <project> --replace <address>` | Plan replacing a resource |
| `teriac plan -p <project> --refresh-only` | Plan updating the state to match what's deployed |
| `teriac apply` | Apply every ready project (can be turned off, see below) |
| `teriac apply -p <project>` | Apply one project. The Apply button does the same |
| `teriac unlock` | Release this PR's locks and drop its plans |

Apply always uses the saved plan, so what runs is exactly what was reviewed.

**Terraform commands** run on one project (`-p <project>`):

| Comment | Needs |
|---|---|
| `teriac validate`, `providers`, `fmt`, `state list [address]` | `plan` |
| `teriac state show <address>`, `show`, `output [name]` | `state_read` |
| `teriac import <address> <id>`, `taint <address>`, `untaint <address>` | `state_write` and approvals |
| `teriac state rm <address>...`, `state mv <from> <to>`, `force-unlock <lock-id>` | `state_remove` and approvals |

Commands that edit the state directly take the project's lock, are audited, and plan the
project again Only these commands run, and arguments are checked, so nothing else (such as `console` or
`-chdir`) can be passed through. Turn direct state edits off for a repo with
`allow_state_changes: false`.

## Settings

| Env var | Default | |
|---|---|---|
| `TERIAC_REQUIRE_APPLY_PROJECT` | `false` | `true` turns off a bare `teriac apply`; people must apply one project at a time with `-p` |
| `TERIAC_REPO_ALLOWLIST` | | Allowed repos, e.g. `github.com/acme/*` (or list them in `repos.yaml`) |
| `TERIAC_REPOS_CONFIG` | `/data/repos.yaml` | Rules, approvers, channels, drift schedules |
| `TERIAC_ACK_REACTION` | `eyes` | Reaction on a command teriac picked up: `eyes`, `rocket`, `+1`, `heart`, `hooray`, `laugh`, `confused`, `-1` or `none`. Per repo: `ack_reaction` |
| `TERIAC_PROGRESS_REPLY` | `false` | Off: each result is posted once, as a new comment, and never edited (👀 shows it was picked up). On: a spinning "Running…" reply that is edited into the result. Needs a public https `TERIAC_PUBLIC_URL`; skipped otherwise. Per repo: `progress_reply` |
| `TERIAC_COMMENT_MODE` | `new` | `new`: each plan and apply gets its own comment under the command. `update`: one comment at the top, edited in place. Per repo: `comment_mode` |
| `TERIAC_PARALLELISM` | `4` | Plans and applies running at once, across all PRs |
| `TERIAC_PR_PARALLELISM` | parallelism − 1 | One PR's share, so other PRs always get a slot. Freed slots go to the PR with the fewest runs going |
| `TERIAC_DEFAULT_VERSION` | `latest` | Tool version when a project pins none |
| `TERIAC_PREINSTALL` | | Warm the cache, e.g. `terraform@1.9.8,tofu@1.8.5` |
| `GITHUB_TOKEN` | | Optional: teriac uses its GitHub App automatically. Set it on servers without a github.com App (GitLab, Bitbucket, GitHub Enterprise) to download OpenTofu and Terragrunt as a signed-in user. Needs no permissions |
| `TERIAC_GITHUB_MIRROR` / `TERIAC_HASHICORP_MIRROR` | | Download OpenTofu/Terragrunt and Terraform from your own mirror (Artifactory, Nexus) instead of GitHub and HashiCorp |
| `TERIAC_DRIFT` | `true` | Run drift schedules |
| `TERIAC_SESSION_SECRET` | random | Signs dashboard sessions (32+ characters). Set it, or sessions end on restart |
| `TERIAC_API_TOKEN` | | Admin token for automation and `/api` |

`TERIAC_*` values are never passed to Terraform. Each secret can also be read from a file:
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
          state_read: [team:platform]    # state show, show, output (optional)
        approvals:
          - { from: team:platform-admins, count: 2 }
          - { from: team:security, count: 1 }
      - match: "**"
        approvals: [{ from: write, count: 1 }]
```

Defaults when no rule applies:

| Permission | Covers | Default | Not set for a project? Uses |
|---|---|---|---|
| `plan` | plans, `validate`, `providers`, `fmt`, `state list` | write | |
| `apply` | applies | write | |
| `apply_destroy` | applies that delete or replace | maintain | |
| `unlock` | releasing another PR's lock | maintain | |
| `state_read` | `state show`, `show`, `output` | write | `plan` |
| `state_write` | `import`, `taint`, `untaint` | write | `apply` |
| `state_remove` | `state rm`, `state mv`, `force-unlock` | maintain | `apply_destroy` |

The last three cover the Terraform commands. When a project doesn't set them, they use the
rule they extend, so they're never looser: limit `apply_destroy` to admins and `state rm` is
admin-only too. Commands that edit the state directly (outside a plan and apply) also need the
project's approvals, like an apply.

Each command also has its own key, for exceptions: `state_list`, `state_show`, `show`, `output`,
`validate`, `providers`, `fmt`, `import`, `taint`, `untaint`, `state_rm`, `state_mv`,
`force_unlock`. A command that isn't set uses its group; `[]` means nobody.

```yaml
permissions:
  state_remove: [admin]   # state rm, state mv, force-unlock: admins
  state_mv: [maintain]    # except state mv: maintainers too
  force_unlock: []        # and nobody may force-unlock
```

Only approvals of the current commit count, and the author's own approval never counts. Each
project needs only its own approvals.

A repo's `teriac.yaml` can name projects, pin versions, and add stricter rules, but never looser
ones. It's read from the base branch, so a PR can't change its own rules.

## What gets planned

teriac finds Terraform, OpenTofu and Terragrunt projects on its own and plans the ones a PR
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
# teriac:watch /lambda/orders/**/*.py scripts/build.sh      ← in any .tf, .tofu or .hcl file

locals {                                                ← Terragrunt, with its functions
  teriac_watch = ["${get_repo_root()}/schemas/*.json"]
}
```

```yaml
# teriac.yaml
projects:
  - dir: stacks/orders
    watch: ["/lambda/orders/**"]
```

Paths are relative to the project folder; a leading `/` means the repo root.

## Terragrunt dependencies

teriac never applies a dependency for you, and never applies a plan built on wrong outputs:
- **Mock outputs.** A unit planned with a dependency's `mock_outputs` (because the dependency
  isn't applied yet) is flagged in the PR and can't be applied, not even with `--override`.
  teriac tells you to apply the dependency first: `teriac apply -p live/prod/vpc`.
- **Re-plans.** When you apply a dependency, teriac re-plans the units that depend on it with the
  real outputs. That's a plan only, for you to review and apply.
- **Outdated plans.** A plan made before one of its dependencies was applied is refused with
  "re-plan first".
- **Order.** Several units applied in one command go in dependency order, and independent ones
  run in parallel.

## Policy checks

Rules run on every plan. In `audit` mode they report; in `enforce` mode they also block apply.
Only people in `override` can apply anyway, with `teriac apply -p <project> --override`. That is
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
  infra-alerts: { type: slack, channel: "#infra-drift", token_env: TERIAC_SLACK_TOKEN }
  ops-teams:    { type: teams, webhook_url_env: TERIAC_TEAMS_WEBHOOK }
people:                                  # optional: git/GitHub → chat identity
  - { name: Bob Martins, github: bob-m, slack: U04BOBM, teams: bob@acme.onmicrosoft.com }

repos:
  - id: github.com/acme/infra
    drift:                               # or under `drift:` in the repo's teriac.yaml
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

GitHub lets anyone with write access edit any comment, including teriac's. teriac never reads its
comments back: what gets applied comes from the plan saved on the server, and check runs (which
users can't edit) and the dashboard are the trusted record. If someone edits or deletes a teriac
comment, teriac posts a warning naming who did it, with a link to the comment and a "View the
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
| Okta or any OIDC provider | `TERIAC_OIDC_ISSUER`, `TERIAC_OIDC_CLIENT_ID`, `TERIAC_OIDC_CLIENT_SECRET`, `TERIAC_OIDC_ADMIN_GROUPS`, `TERIAC_OIDC_ALLOWED_GROUPS`. Redirect URI: `<public url>/auth/oidc/callback` |
| Username and password | `dashboard.users` in `repos.yaml`, or `TERIAC_DASHBOARD_USERS_FILE`. Hash passwords with `node packages/server/src/hash-password.ts` |
| API token | `TERIAC_API_TOKEN` (admin) |

Sessions are signed, HttpOnly cookies. Login attempts are rate limited, and the page loads nothing
from third parties.

## API

These need a dashboard session or `Authorization: Bearer $TERIAC_API_TOKEN`:
- `GET /api/runs`
- `GET /api/locks`
- `GET /api/audit`
- `GET /api/drift`
- `GET /api/drift/schedules`
- `POST /api/drift/run?key=…` (admin)
- `POST /api/locks/unlock` (admin)

`/healthz`, `/readyz` and `/metrics` (Prometheus) are open.
