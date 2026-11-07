# tfv — Terraform, OpenTofu & Terragrunt Version Manager for macOS, Linux & Windows

```text
         _        ________        __
       _| |__   / _____|\ \      / /
      |_  ___\ | |___    \ \    / /
        | |    |  ___|    \ \  / /
        | |___ | |         \ \/ /
        \______\_|          \__/

        Happy terraforming! 😍🥂
    ---------------------------------
```

`tfv` lets you install, switch, and manage multiple versions of **Terraform**, **OpenTofu** and **Terragrunt** without `sudo`. All binaries live in `~/.tfv/` — upgrading `tfv` itself never wipes your installed versions.

![tfv demo](https://raw.githubusercontent.com/marcdomain/tfv/main/demo.gif)

---

## Installation

```sh
npm install -g tfv
```

`tfv` automatically adds `~/.tfv/bin` to your PATH on install (shell configs, fish `conf.d`, or Windows User PATH). Restart your terminal once after install.

If your package manager skips install scripts (pnpm 10, Bun, Yarn Berry, `--ignore-scripts`) or you installed with `sudo`, the same setup runs automatically the first time you run `tfv`.

---

## How it works

```text
npm install -g tfv
       │
       ▼
postInstall.js  (or first `tfv` run, if install scripts were skipped)
  ├── creates ~/.tfv/bin/, ~/.tfv/store/, ~/.tfv/cache/
  └── adds ~/.tfv/bin to PATH (shell configs / Windows registry)
       │
       ▼
tfv install 1.9.0
  ├── fetches version list  →  ~/.tfv/cache/terraform-versions.json  (1hr TTL)
  ├── downloads zip         →  system temp dir  (with progress bar)
  ├── verifies SHA256       →  HashiCorp / OpenTofu checksums
  ├── extracts binary only  →  ~/.tfv/store/terraform/1.9.0
  └── records arch          →  ~/.tfv/store/terraform/arch.json
       │
       ▼
tfv use 1.9.0
  ├── copies ~/.tfv/store/terraform/1.9.0  →  ~/.tfv/bin/terraform
  └── writes active version  →  ~/.tfv/active.json

       │
       ▼
terraform plan   ← resolves to ~/.tfv/bin/terraform  (same binary as tfv)
tfv plan         ← spawns ~/.tfv/bin/terraform directly (no PATH lookup)
```

Both `terraform` and `tfv` commands always use the **exact same binary**.

---

## Store layout

```text
~/.tfv/
  bin/
    terraform          ← active terraform binary (no sudo, no symlinks)
    tofu               ← active opentofu binary
    terragrunt         ← active terragrunt binary
  store/
    terraform/
      1.9.0            ← installed versions (binary renamed to version number)
      1.7.3
      arch.json        ← { "1.9.0": "arm64", "1.7.3": "amd64" }
    opentofu/
      1.8.0
      arch.json
    terragrunt/
      1.2.1
      arch.json
  cache/
    terraform-versions.json   ← remote list cached for 1 hour
    opentofu-versions.json
  active.json          ← { "terraform": "1.9.0", "opentofu": null, "terragrunt": "1.2.1" }
```

---

## Commands

### Install

```sh
tfv install latest                   # latest stable
tfv install 1.9.0                    # exact version
tfv install 1.9.^                    # latest 1.9.x patch
tfv install 1.8.0-beta1              # explicit pre-release (warns you)
tfv install latest --provider tofu   # OpenTofu
tfv install 1.9.0 --arch amd64       # override architecture
```

Aliases: `tfv i`

---

### Switch version

```sh
tfv use 1.9.0
tfv use latest                       # latest installed version
tfv use 1.8.0 --provider tofu
```

No `sudo`. Copies binary to `~/.tfv/bin/terraform`.

---

### Auto-switch

Detects and switches to the version your project requires. Installs it if not already in store.

```sh
tfv auto-switch
tfv as                               # alias
tfv as --provider tofu
```

Reads version from (in priority order):

1. A version file in the current directory:
   - Terraform: `.terraform-version`, `.tfswitchrc`, `.tfswitch.toml`, or a `terraform` line in `.tool-versions` (asdf / mise)
   - OpenTofu: `.opentofu-version`, `.tofu-version`, an `opentofu` or `tofu` line in `.tool-versions`, then `.terraform-version`
2. `terraform.tfstate` → `terraform_version` field
3. `required_version` in any `.tf` file — supports all constraint operators:
   `=`, `>=`, `>`, `<=`, `<`, `!=`, `~>`, and compound `">= 1.3, < 2.0"`

---

### Shell hook — auto-switch on `cd`

Wraps `cd` so that entering a directory automatically switches the terraform version — but **only if the directory looks like a terraform project**. Non-terraform folders have zero overhead (one filesystem check, no subprocess).

A directory is considered a terraform project if it contains:

- a version file (`.terraform-version`, `.opentofu-version`, `.tofu-version`, `.tfswitchrc`, `.tfswitch.toml`), **or**
- a `.tool-versions` file with a `terraform`, `opentofu` or `tofu` line, **or**
- any `*.tf` files

The hook switches Terraform as above, and also switches OpenTofu when the project pins it with its own file (`.opentofu-version`, `.tofu-version` or `.tool-versions`).

```sh
cd ~/Downloads           # no .tf files → nothing happens
cd ~/projects/react-app  # no .tf files → nothing happens
cd ~/projects/infra      # has main.tf  → auto-switch runs silently
cd ~/projects/platform   # has .terraform-version → auto-switch runs silently
```

Setup (one-time, add to your shell config):

```sh
# Bash
printf '\neval "$(tfv shell-init bash)"\n' >> ~/.bashrc

# Zsh
printf '\neval "$(tfv shell-init zsh)"\n' >> ~/.zshrc

# Fish
printf '\ntfv shell-init fish | source\n' >> ~/.config/fish/config.fish

# PowerShell
Add-Content $PROFILE "`nInvoke-Expression (tfv shell-init powershell | Out-String)"
```

After setup, entering a terraform project switches the version automatically — no manual `tfv as` needed.

`shell-init` also installs **tab completions** for all `tfv` commands and installed versions. After running the setup command above, `tfv <tab>` will complete commands, `tfv use <tab>` will complete installed versions, and `tfv --provider <tab>` will complete provider names.

---

### List versions

```sh
tfv list                             # installed versions (default)
tfv ls --remote                      # all available versions from HashiCorp
tfv ls --remote --provider tofu      # all available OpenTofu versions
```

Active version is marked with 🚀.

---

### Current version

```sh
tfv current                          # shows active version + PATH status
tfv which                            # alias
tfv current --provider tofu
```

Example output:

```text
Active terraform version: 1.9.0
Binary: /Users/you/.tfv/bin/terraform
Reported: Terraform v1.9.0
PATH OK — 'terraform' resolves to tfv-managed binary
```

---

### Pin version

Writes a version file in the current directory so teammates get the same version via `tfv auto-switch`. Each tool has its own file, so pinning one never switches another:

```sh
tfv pin                              # pin currently active version → .terraform-version
tfv pin 1.9.0                        # pin a specific version
tfv pin --provider tofu              # → .opentofu-version
tfv pin --provider terragrunt        # → .terragrunt-version
```

---

### Upgrade

```sh
tfv upgrade                          # upgrade active 1.6.3 → latest 1.6.x patch
tfv upgrade 1.9                      # install + use latest 1.9.x
tfv upgrade latest                   # install + use absolute latest
tfv upgrade --provider tofu
```

Also re-anchors `~/.tfv/bin` in PATH to ensure it takes precedence over any system-installed terraform.

---

### Remove

```sh
tfv remove 1.7.3
tfv rm 1.7.3 1.6.6                   # remove multiple
tfv rm 1.8.0 --provider tofu
```

Warns if you're removing the currently active version.

---

### Prune

Remove all non-active versions at once to free disk space.

```sh
tfv prune                            # remove everything except the active version
tfv prune --keep 2                   # keep the 2 most recent + the active version
tfv prune --provider tofu
tfv prune --yes                      # skip confirmation prompt
```

The active version is always kept regardless of `--keep`.

---

### Exec

Run a single command with a specific installed version **without** changing the active version. Useful for cross-version testing and CI.

```sh
tfv exec 1.9.0 -- version
tfv exec 1.8.0 -- plan -var="env=prod"
tfv exec 1.7.3 --provider tofu -- validate
```

Pass all terraform/tofu flags after `--`.

---

### Doctor

Run a full health check: store directories, active binaries, PATH order, PATH conflicts, and shell config.

```sh
tfv doctor
```

Example output:

```text
tfv doctor

Store
  ✔  ~/.tfv/store/terraform/ exists
  ✔  ~/.tfv/store/opentofu/ exists

Active versions
  ✔  terraform: active version is 1.9.0
  ✔  terraform: binary exists
  ✔  terraform: executes  (Terraform v1.9.0)
  –  tofu: not set up (no versions installed)

PATH
  ✔  ~/.tfv/bin is in PATH
  ✔  ~/.tfv/bin precedes system dirs in PATH
  ✔  'terraform' resolves to tfv-managed binary
  ✔  PATH block found in shell config (~/.zshrc)

Cache
  ✔  terraform version cache exists
  –  opentofu version cache not yet created

All checks passed. tfv is healthy.
```

Exits with code 1 if any issue is found.

---

### Terraform commands (via tfv)

All commands use the tfv-managed binary and accept extra terraform flags after `--`:

```sh
tfv init
tfv validate
tfv fmt
tfv fmt -- -recursive

tfv plan
tfv plan --file main.tf                        # extract targets from file
tfv plan --file main.tf --file network.tf      # multiple files
tfv plan --file main.tf -- -var="env=prod"     # with extra terraform flags

tfv apply --file main.tf -- -auto-approve
tfv destroy --file main.tf -- -auto-approve
```

`--file` parses `.tf` files and auto-generates `-target` flags for every `resource`, `data`, and `module` block found. Comments are stripped before parsing.

All commands support `--provider tofu` to use OpenTofu instead.

---

## OpenTofu support

Every command works with OpenTofu via `--provider tofu` (or `--provider opentofu`):

```sh
tfv install latest --provider tofu
tfv use 1.8.0 --provider tofu
tfv list --remote --provider tofu
tfv current --provider tofu
tfv plan --provider tofu
```

OpenTofu binaries are stored separately from Terraform in `~/.tfv/store/opentofu/` and activated as `~/.tfv/bin/tofu`.

---

## Terragrunt support

Terragrunt works the same way via `--provider terragrunt` (or `-p tg`):

```sh
tfv install latest -p tg
tfv use 1.2.1 -p tg
tfv list --remote -p tg
tfv pin -p tg                        # writes .terragrunt-version
tfv auto-switch -p tg
```

`tfv auto-switch -p tg` (and the shell hook) reads, in order: `.terragrunt-version`, `.tgswitchrc`, a `terragrunt` line in `.tool-versions`, then `terragrunt_version_constraint` in `terragrunt.hcl` / `root.hcl`.

Terraform also picks up `terraform_version_constraint` from `terragrunt.hcl` / `root.hcl`, so in a Terragrunt project one `cd` switches both tools:

```hcl
# terragrunt.hcl
terraform_version_constraint  = "~> 1.9"
terragrunt_version_constraint = ">= 1.0, < 2.0"
```

Terragrunt binaries live in `~/.tfv/store/terragrunt/` and are activated as `~/.tfv/bin/terragrunt`.

---

## Provider plugin cache

Share downloaded providers across all your projects, so each provider version downloads once instead of once per project:

```sh
tfv plugin-cache on                  # enable
tfv plugin-cache status              # show what's set
tfv plugin-cache off                 # remove what tfv added
```

This sets `plugin_cache_dir` in your Terraform CLI config (`~/.terraformrc`, or `%APPDATA%\terraform.rc` on Windows), with the cache in `~/.terraform.d/plugin-cache`. OpenTofu reads the same file unless you have a `~/.tofurc`, which tfv then updates too. tfv never changes a `plugin_cache_dir` you set yourself.

---

## Mirrors, proxies & offline use

Download from an internal mirror (Artifactory, Nexus, ...) instead of the public sites. Each variable replaces one host and keeps the rest of the path:

| Variable | Replaces | Used for |
|---|---|---|
| `TFV_HASHICORP_MIRROR` | `https://releases.hashicorp.com` | Terraform (downloads and version list) |
| `TFV_GITHUB_MIRROR` | `https://github.com` | OpenTofu and Terragrunt downloads |

```sh
export TFV_HASHICORP_MIRROR=https://artifactory.example.com/artifactory/hashicorp
export TFV_GITHUB_MIRROR=https://user:token@nexus.example.com/repository/github
```

Plain `http://` mirrors and credentials in the URL are supported. Checksums are still verified against the mirrored `SHA256SUMS` file.

OpenTofu and Terragrunt version lists come from the GitHub API. If it can't be reached, installing an exact version (`tfv install 1.8.0 -p tofu`) still works; `latest` needs the list. Set `GITHUB_TOKEN` to raise GitHub's limit of 60 requests an hour.

---

## Windows support

Everything works on Windows without administrator privileges:

- Store: `%USERPROFILE%\.tfv\`
- PATH: updated via `[Environment]::SetEnvironmentVariable("PATH", ..., "User")` (User scope, no admin)
- Shell hooks: PowerShell profile integration via `tfv shell-init powershell`

---

## Help

```sh
tfv --help
tfv <command> --help
```
