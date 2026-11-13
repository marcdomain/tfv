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
- **Permissions** (Settings → Developer settings → GitHub Apps → your App → Permissions and events):

  | Permission | Access | What teriac uses it for |
  |---|---|---|
  | Repository → **Checks** | Read & write | A check run per plan, the **Apply** button, and code annotations on risky lines |
  | Repository → **Contents** | Read | Cloning the PR, reading `teriac.yaml` and `CODEOWNERS`, comparing the branch with its base (out-of-date warnings, keeping approvals after a rebase) |
  | | Read & write | Only for drift fix PRs (`fix_pr: true`): pushing the fix branch |
  | Repository → **Issues** | Read & write | Posting and editing comments, and the 👀 reaction on commands (PR comments use the Issues API) |
  | Repository → **Pull requests** | Read & write | Changed files, reviews and approvals, mergeable state, and opening drift fix PRs |
  | Repository → **Metadata** | Read | Required by GitHub for every App |
  | Organization → **Members** | Read | `team:` rules: approvers, permissions, `override` lists and emergency-access grantors |

  Nothing else is needed: no Administration, Workflows, Secrets or Actions access. After changing
  permissions, an org owner must accept them under the org's *Installed GitHub Apps*, or the App
  keeps the old ones.
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
| `TERIAC_DATA_DIR` | `/data` | Database, plans, checkouts and downloaded tools |
| `TERIAC_PORT` | `8080` | HTTP port |
| `TERIAC_PUBLIC_URL` | `http://localhost:<port>` | The address people and GitHub use, for links and the dashboard. With a public `https` address, PR comments show round profile pictures, served by teriac at `/avatars/round/…` (public, and only for your GitHub host); otherwise GitHub's square ones |
| `TERIAC_GITHUB_API_URL` | `https://api.github.com` | GitHub Enterprise Server: `https://<host>/api/v3` |
| `TERIAC_RUN_TIMEOUT_SECONDS` | `3600` | Longest one Terraform command may run |
| `TERIAC_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `TERIAC_SESSION_HOURS` | `12` | How long a dashboard sign-in lasts |
| `TERIAC_MODULE_AUTH` | `true` | A read-only App token for Terraform's `git::https://` module downloads; see [Module sources](#settings) |
| `TERIAC_VERIFY_SIGNATURES` | `true` | Check the vendor's signature on downloaded Terraform, OpenTofu and Terragrunt. `false` for mirrors that don't copy `.sig` files |
| `TERIAC_BACKUP_ENABLED` | `false` | Scheduled database backups; see [Backups](#backups) for the `TERIAC_BACKUP_*` settings |

`TERIAC_*` values are never passed to Terraform. Each secret can also be read from a file:
`<NAME>_FILE` (for example `TERIAC_SESSION_SECRET_FILE`).

**Module sources.** Use `git::https://` module sources (the image has no SSH client). Private
modules work with no setup: for each plan, apply and drift check, teriac asks the GitHub App for
a token that can **only read code** (`contents: read`) and gives it to git as a header for your
GitHub host. It never touches disk and lasts an hour. Terraform runs the PR's code, so it never
gets the App's full token. The token reaches every repo the App is installed on, so anyone who can
open a PR could read those repos during a plan; install the App only where that's fine, or set
`TERIAC_MODULE_AUTH=false` (Helm: `config.moduleAuth: false`). To use your own credentials
instead, set `GIT_CONFIG_*` with `extraEnv` (for example `GIT_CONFIG_COUNT=1`,
`GIT_CONFIG_KEY_0=url.https://x-access-token:<token>@github.com/.insteadOf`,
`GIT_CONFIG_VALUE_0=https://github.com/`); teriac then leaves git's settings alone.

Terraform, scanners and scripts get the PR's details instead: `TERIAC_REPO`, `TERIAC_PR_NUMBER`,
`TERIAC_HEAD_SHA`, `TERIAC_PROJECT`, `TERIAC_WORKSPACE` and `TERIAC_USER` (who ran the command).
Drift checks set `TERIAC_REPO`, `TERIAC_BRANCH`, `TERIAC_PROJECT` and `TERIAC_WORKSPACE`.

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

Each entry's `id` is one repo (`github.com/acme/infra`) or a glob (`github.com/acme/*`). A repo uses
only the first entry that matches; entries don't combine, so list exact repos before globs and give
each everything it needs. Drift schedules need an exact repo.

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
  mode: enforce               # off | audit | enforce (a repo entry can make it stricter, not looser)
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
  builtin: [security]         # ready-made AWS security rules (below)
  disable: [aws-kms-rotation-off]   # turn single built-in rules off
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

**Built-in security rules** (`builtin: [security]`): they report like any other rule, so `mode`,
`--override` and the findings tab all apply.

| Rule | Flags |
|---|---|
| `aws-s3-public-acl` | bucket ACLs `public-read`, `public-read-write`, `authenticated-read` |
| `aws-s3-public-access-block-off` | a public access block with any setting turned off |
| `aws-s3-public-policy` | a bucket policy allowing `"Principal": "*"` without a condition |
| `aws-security-group-open-ingress` | ingress from `0.0.0.0/0` or `::/0` on anything but ports 80 and 443 |
| `aws-storage-unencrypted` | RDS, Aurora, DocumentDB, Neptune, EBS, EFS, ElastiCache or Redshift without encryption |
| `aws-iam-wildcard` | an IAM policy allowing `"Action": "*"` on `"Resource": "*"` |
| `aws-database-public` | a publicly accessible database |
| `aws-deletion-protection-off` | deletion protection turned off on a database, table or load balancer |
| `aws-kms-key-deleted` | a KMS key destroyed or replaced |
| `aws-kms-rotation-off` | a symmetric KMS key without rotation |
| `aws-audit-or-backup-removed` | CloudTrail, AWS Config, GuardDuty or a backup vault or plan deleted, or CloudTrail logging off |
| `aws-eks-public-endpoint` | an EKS API endpoint open to the whole internet |

## Two-person rule

`two_person_rule: true` on a repo, or on a project rule in `repos.yaml`, means the PR's author
can't apply it; someone else with apply rights must.

## Approvals, rebases and out-of-date branches

```yaml
repos:
  - id: github.com/acme/*
    reapprove_on_change: true      # default true: a code change needs a fresh approval
    keep_approval_on_rebase: true  # default false: a rebase or "Update branch" keeps approvals
    stale_base: warn               # off | warn (default) | block
    verify_plan: true              # default true: apply only the exact plan file reviewed
```

- **Rebases.** teriac fingerprints the PR's own changes: the files it changes and their exact
  contents, compared with where the branch left the base. When an approval was given on an earlier
  commit and the fingerprint is the same now, only the base moved, so the approval still counts.
  The comment says whose approval was kept. A rebase where conflicts were resolved changes the
  fingerprint and needs a new approval. When teriac can't compare (for example, more than 300
  files changed), it asks for a new approval.
- **Out-of-date branches.** At plan and apply, teriac checks whether the base branch changed any
  file a project uses (its folder, local modules, Terragrunt dependencies, watched files) since the
  PR branched. Applying such a branch could undo those changes. `warn` shows the commits on the PR
  and in the apply reply; `block` refuses the apply until the branch is updated.
- **Reviewed plan only.** The plan file's SHA-256 is saved when it's made and checked again before
  apply. A changed or missing file is refused, audited, and must be planned again.

A repo's `teriac.yaml` can make these stricter (`reapprove_on_change: true`,
`keep_approval_on_rebase: false`, a stricter `stale_base`), never looser.

## Risk score

Every plan with changes gets a risk level, from fixed rules, so the same plan always gets the
same score. The PR comment's Risk column shows the level, or **None** when nothing risky was found;
the reasons are in each project's dropdown and on its check run.

| Raises the level to | When the plan |
|---|---|
| Critical | destroys or replaces a stateful resource (database, bucket, KMS key, DNS zone, cluster, volume…) in production |
| High | does that outside production; destroys anything in production; changes access (IAM, roles, policies) in production; changes more than 100 resources (`size_limits.high`); has high or critical policy findings |
| Medium | destroys anything elsewhere; changes access or network resources; changes more than 25 resources (`size_limits.medium`); has medium findings; changes production at all |
| None | anything else |

```yaml
risk:                                   # in repos.yaml (server-wide or per repo)
  production: ["prod/**", "live/prod/**"]   # default: folders named prod, production or prd
  stateful_types: ["mongodbatlas_cluster", "snowflake_database", "confluent_kafka_*"]  # added to the built-in list
  size_limits: { medium: 25, high: 100 }    # changed resources that make a plan medium / high
  extra_approval:
    high: { from: team:sre, count: 1 }      # high and critical need one SRE approval
    critical: { from: team:sre, count: 2 }
```

What counts as stateful (built in): databases and clusters (RDS, Aurora, DynamoDB, Cloud SQL, Cosmos DB,
Redis, OpenSearch, Kafka…), storage (S3, GCS, Azure storage, EBS, EFS, disks), keys and secrets (KMS,
Key Vault, Secrets Manager), DNS zones, Kubernetes clusters, namespaces and volumes, backup vaults and
CloudTrail. `stateful_types` adds your own. Policy findings feed the score too, so a rule with
`severity: critical` makes a plan at least High.

**Server-wide and per repo.** `risk`, `freezes`, `protected`, `secret_scan` and `policies` can be set
at the top of `repos.yaml` (every repo) and in a repo's entry (that repo only):

- **Lists add up:** `freezes`, `protected`, `policies.rules`, `risk.stateful_types`.
- **Only stricter:** `secret_scan`, `policies.mode`, `risk.size_limits` (the server sets a minimum).
- **Anything else** set on the repo wins for that repo (`risk.production`, `risk.extra_approval`,
  `policies.override`).

A repo's own `teriac.yaml` is different: repo owners control it, so it can only tighten
(`reapprove_on_change`, `keep_approval_on_rebase`, `stale_base`, and its rules).

The check run also puts notes on the code: each resource block that will be destroyed or replaced,
and each policy finding, shows up on its line in the PR's **Files changed**.

## Change freezes and protected resources

```yaml
freezes:                                # in repos.yaml (server-wide or per repo)
  - { name: weekend, projects: ["prod/**"], schedule: "0 15 * * 5", hours: 63, timezone: Europe/Madrid, override: [team:sre] }  # Fri 15:00 → Mon 06:00
  - { name: holidays, from: "2026-12-23", to: "2027-01-02" }   # whole days, both included; no override
protected:
  - { projects: ["prod/**"], resources: ["aws_db_instance.*", "aws_kms_key.*"], override: [team:sre] }
```

During a freeze, plans still run but applies and state edits (`import`, `state rm`, …) are
refused, with when the freeze ends. A protected resource is never destroyed or replaced:
the apply is refused and the block is marked on the code. Resource globs match inside modules too
(`aws_db_instance.*` covers `module.db.aws_db_instance.main[0]`).

Each entry has its own `override`: the people who may apply anyway with
`teriac apply -p <project> --override`. Without one, nobody can skip that entry. `--override` skips
only the entries (and policy findings, via `policies.override`) whose list includes the person; the
reply says who can override what is still blocking, and every use is audited.

## Leaked-secret scan

Before any output reaches a PR comment, a check run or the dashboard, teriac looks for things that
look like secrets: AWS keys, private keys, GitHub, GitLab, Slack and npm tokens, Slack webhooks,
Google API keys, Stripe keys, JWTs, Azure storage keys, and `password = "…"` in plan lines.
Terraform's own `(sensitive value)` is left alone.

```yaml
secret_scan:                            # in repos.yaml
  mode: redact                          # redact (default) | fail | off; a repo entry can make it stricter, not looser
  patterns:                             # your own, optional
    - { name: acme-token, regex: "acme_[0-9a-f]{32}" }
```

- `redact` replaces each match with `‹redacted: aws-access-key›` and adds a warning.
- `fail` also refuses the plan, so it can't be applied until the secret is gone.

Every find is audited.

## Emergency access

```yaml
break_glass:                            # in repos.yaml
  grantors: [admin, "user:sre-lead@acme.com", "group:oncall"]  # dashboard admins, people, SSO groups
  max_hours: 4
  notify: [infra-alerts]
```

On the dashboard's **Access** page, a grantor gives someone a permission for a few hours, with a
reason: for example `apply` on `prod/**`. A grant can also skip approvals, freezes, protected
resources or enforced policies, for when the people who'd approve can't be reached. It ends on its
own, and can be revoked. The grant, its first use, a revoke and the expiry all go to the audit log
and the `notify` channels.

## Weekly summary

```yaml
summary:                                # in repos.yaml
  schedule: "0 9 * * 1"                 # Mondays at 09:00
  timezone: Europe/Madrid
  notify: [infra-alerts]
  days: 7
```

It sends:
- runs, failures, and how fast changes ship (PR to applied, failed applies, time to fix);
- open drift, and locks held for more than 3 days;
- the slowest projects and the most active people;
- policy findings, refused actions, and emergency access given.

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
        timezone: Europe/Madrid
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

**Fix PRs.** With `fix_pr: true` on a schedule, teriac opens a PR that updates the code to match
what is running, and links it in the message. It only edits values written plainly in the
resource block (a string, number or `true`/`false`) that still match the last applied value.
Values from variables, expressions, modules and nested blocks are listed in the PR for a person,
with who last changed them. Merge the PR to accept the change; close it and apply the base branch
to put things back. One PR per project at a time (branch `teriac/drift-fix/<project>`). The
GitHub App needs **Contents: read & write** for this.

## Backups

Runs, locks, the audit log, drift history and metrics live in a SQLite database on the server's
volume. With backups on, the server copies the database **only at the scheduled times**,
gzips the copy, uploads it to S3, GCS or Azure, and deletes the local copy. Nothing builds
up on the volume, whether the upload works or not.

| Setting | Helm value | Default | Does |
|---|---|---|---|
| `TERIAC_BACKUP_ENABLED` | `backup.enabled` | `false` | Turn backups on |
| `TERIAC_BACKUP_SCHEDULE` | `backup.schedule` | `0 3 * * *` in the chart | When to back up (cron: minute hour day month weekday). Required |
| `TERIAC_BACKUP_TIMEZONE` | `backup.timezone` | `UTC` | Time zone of the schedule |
| `TERIAC_BACKUP_BACKEND` | the section you fill in: `backup.backend.s3`, `.gcs` or `.azure` | | `s3`, `gcs` or `azure`. `s3` also covers MinIO, Cloudflare R2, Backblaze B2, … |
| `TERIAC_BACKUP_BUCKET` | `backup.backend.s3.bucket`, `.gcs.bucket` or `.azure.container` | | Bucket (Azure: container) name only |
| `TERIAC_BACKUP_PATH` | `backup.backend.<s3, gcs or azure>.path` | `teriac` (chart: `teriac/<namespace>/<release>`) | Folder in the bucket |
| `TERIAC_BACKUP_S3_REGION` / `_S3_ENDPOINT` / `_S3_STORAGE_CLASS` | `backup.backend.s3.region`, `.endpoint`, `.storageClass` | | Region; endpoint for S3-compatible services only; storage class |
| `TERIAC_BACKUP_AZURE_ACCOUNT` | `backup.backend.azure.accountName` | | Storage account (required for Azure) |
| `TERIAC_BACKUP_NOTIFY` | `backup.notify` | | Channels told when a backup fails, and when backups work again |

**Credentials.** By default the server signs in as itself: IRSA or EKS Pod Identity, GKE
Workload Identity, or Azure Workload Identity. Otherwise use `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` (S3), `GOOGLE_APPLICATION_CREDENTIALS` (GCS), or
`TERIAC_BACKUP_AZURE_KEY` (Azure). In Helm, `backup.backend.existingSecret` names a Secret
with `access-key-id` and `secret-access-key`, `credentials.json`, or `account-key`.

**Bucket permissions.** S3: `s3:ListBucket` on the bucket, `s3:GetObject` and
`s3:PutObject` on the path (plus `kms:GenerateDataKey` and `kms:Decrypt` with SSE-KMS). GCS:
`roles/storage.objectUser`. Azure: *Storage Blob Data Contributor*. Nothing needs delete
or create-bucket rights.

**Old backups.** teriac never deletes backups. Add a lifecycle rule (expiration) to the
bucket for the backup path. Each backup (`teriac-20261111T030000000Z.db.gz`) is a whole
database on its own, so expiring old ones never breaks newer ones. Keep the expiry well
above the time between backups (daily backups: 7 days or more), so a recent one always
exists.

**Restoring.** When the server starts and its volume has no database (a new PVC, a lost
disk, or `persistence.enabled: false`), it restores the newest backup that passes SQLite's
integrity check. A broken backup, or one the lifecycle rule removed after it was listed, is
skipped for the one before. A volume that already has a database is kept as is. If the
bucket can't be read (wrong name or credentials), the server doesn't start, rather than
start empty and hide the problem. Set `TERIAC_BACKUP_ENABLED=false` to start without
restoring. Changes since the last backup are lost with the volume, so back up as often as
that matters to you.

**Watching it.** The dashboard's **Guardrails** page shows the destination, the next
backup, the latest results and a **Back up now** button for admins (audited).
`/metrics` has `teriac_backup_last_ok` and `teriac_backup_last_success_timestamp_seconds`,
for an alert such as "no good backup in 26 hours". A backup needs free space on the
volume about the size of the database while it runs.

Docker:

```sh
docker run -d -p 8080:8080 -v teriac-data:/data \
  -e TERIAC_BACKUP_ENABLED=true -e TERIAC_BACKUP_SCHEDULE='0 3 * * *' \
  -e TERIAC_BACKUP_BACKEND=s3 -e TERIAC_BACKUP_BUCKET=acme-backups -e TERIAC_BACKUP_S3_REGION=eu-west-1 \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  … ghcr.io/marcdomain/teriac-server
```

## Tamper-proof output

GitHub lets anyone with write access edit any comment, including teriac's. teriac never reads its
comments back: what gets applied comes from the plan saved on the server, and check runs (which
users can't edit) and the dashboard are the trusted record. If someone edits or deletes a teriac
comment, teriac posts a warning naming who did it, with a link to the comment and a "View the
original" section, and logs it in the audit log.

## Dashboard

Open the server's URL in a browser. It shows:
- an overview of runs, failures, locks and drift, with a banner while a change freeze is on;
- every plan and apply, with its risk, change list and redacted log;
- locks, with an Unlock button;
- drift schedules, findings, and who last changed each resource;
- the audit log;
- **Guardrails**: change freezes (and whether one is on now), protected resources, risk,
  policy and secret-scan settings, each repo entry's approval settings, and database
  backups with a **Back up now** button (see [Backups](#backups));
- **Access**: emergency access grants (see [Emergency access](#emergency-access));
- **Metrics**: runs, timings, resource use, and delivery: PR to applied, failed applies, time to
  fix, applies per week.

It has light and dark themes. Viewers can see everything; admins can also unlock, start drift
checks and start a backup.

| Sign-in | Settings |
|---|---|
| Okta or any OIDC provider | `TERIAC_OIDC_ISSUER`, `TERIAC_OIDC_CLIENT_ID`, `TERIAC_OIDC_CLIENT_SECRET`, `TERIAC_OIDC_ADMIN_GROUPS`, `TERIAC_OIDC_ALLOWED_GROUPS`; optional `TERIAC_OIDC_NAME` (button label), `TERIAC_OIDC_SCOPES` (default `openid,profile,email,groups`), `TERIAC_OIDC_GROUPS_CLAIM` (default `groups`). Redirect URI: `<public url>/auth/oidc/callback` |
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
- `GET /api/safety` (the Guardrails page)
- `GET /api/backups`
- `POST /api/backups/run` (admin)

`/healthz`, `/readyz` and `/metrics` (Prometheus) are open.
