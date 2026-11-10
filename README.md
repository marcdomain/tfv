# teriac — Terraform, OpenTofu & Terragrunt Version Manager for macOS, Linux & Windows

```text
       _                _
      | |_   ___  _ __ (_)  __ _   ___
      | __| / _ \| '__|| | / _' | / __|
      | |_ |  __/| |   | || (_| || (__
       \__| \___||_|   |_| \__,_| \___|

          Happy terraforming! 😍🥂
      ---------------------------------
```

`teriac` lets you install, switch, and manage multiple versions of **Terraform**, **OpenTofu** and **Terragrunt** without `sudo`. All binaries live in `~/.teriac/` — upgrading `teriac` itself never wipes your installed versions.

![teriac demo](https://raw.githubusercontent.com/marcdomain/teriac/main/demo.gif)


---

## Installation

```sh
npm install -g @marcdomain/teriac
```

`teriac` automatically adds `~/.teriac/bin` to your PATH on install (shell configs, fish `conf.d`, or Windows User PATH). Restart your terminal once after install.

If your package manager skips install scripts (pnpm 10, Bun, Yarn Berry, `--ignore-scripts`) or you installed with `sudo`, the same setup runs automatically the first time you run `teriac`.

---

## How it works

```text
npm install -g @marcdomain/teriac
       │
       ▼
postInstall.js  (or first `teriac` run, if install scripts were skipped)
  ├── creates ~/.teriac/bin/, ~/.teriac/store/, ~/.teriac/cache/
  └── adds ~/.teriac/bin to PATH (shell configs / Windows registry)
       │
       ▼
teriac install 1.9.0
  ├── fetches version list  →  ~/.teriac/cache/terraform-versions.json  (1hr TTL)
  ├── downloads zip         →  system temp dir  (with progress bar)
  ├── verifies SHA256       →  HashiCorp / OpenTofu checksums
  ├── extracts binary only  →  ~/.teriac/store/terraform/1.9.0
  └── records arch          →  ~/.teriac/store/terraform/arch.json
       │
       ▼
teriac use 1.9.0
  ├── copies ~/.teriac/store/terraform/1.9.0  →  ~/.teriac/bin/terraform
  └── writes active version  →  ~/.teriac/active.json

       │
       ▼
terraform plan   ← resolves to ~/.teriac/bin/terraform  (same binary as teriac)
teriac plan         ← spawns ~/.teriac/bin/terraform directly (no PATH lookup)
```

Both `terraform` and `teriac` commands always use the **exact same binary**.

---

## Store layout

```text
~/.teriac/
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
teriac install latest                   # latest stable
teriac install 1.9.0                    # exact version
teriac install 1.9.^                    # latest 1.9.x patch
teriac install 1.8.0-beta1              # explicit pre-release (warns you)
teriac install latest --provider tofu   # OpenTofu
teriac install 1.9.0 --arch amd64       # override architecture
```

Aliases: `teriac i`

---

### Switch version

```sh
teriac use 1.9.0
teriac use latest                       # latest installed version
teriac use 1.8.0 --provider tofu
```

No `sudo`. Copies binary to `~/.teriac/bin/terraform`.

---

### Auto-switch

Detects and switches to the version your project requires. Installs it if not already in store.

```sh
teriac auto-switch
teriac as                               # alias
teriac as --provider tofu
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
printf '\neval "$(teriac shell-init bash)"\n' >> ~/.bashrc

# Zsh
printf '\neval "$(teriac shell-init zsh)"\n' >> ~/.zshrc

# Fish
printf '\nteriac shell-init fish | source\n' >> ~/.config/fish/config.fish

# PowerShell
Add-Content $PROFILE "`nInvoke-Expression (teriac shell-init powershell | Out-String)"
```

After setup, entering a terraform project switches the version automatically — no manual `teriac as` needed.

`shell-init` also installs **tab completions** for all `teriac` commands and installed versions. After running the setup command above, `teriac <tab>` will complete commands, `teriac use <tab>` will complete installed versions, and `teriac --provider <tab>` will complete provider names.

---

### List versions

```sh
teriac list                             # installed versions (default)
teriac ls --remote                      # all available versions from HashiCorp
teriac ls --remote --provider tofu      # all available OpenTofu versions
```

Active version is marked with 🚀.

---

### Current version

```sh
teriac current                          # shows active version + PATH status
teriac which                            # alias
teriac current --provider tofu
```

Example output:

```text
Active terraform version: 1.9.0
Binary: /Users/you/.teriac/bin/terraform
Reported: Terraform v1.9.0
PATH OK — 'terraform' resolves to teriac-managed binary
```

---

### Pin version

Writes a version file in the current directory so teammates get the same version via `teriac auto-switch`. Each tool has its own file, so pinning one never switches another:

```sh
teriac pin                              # pin currently active version → .terraform-version
teriac pin 1.9.0                        # pin a specific version
teriac pin --provider tofu              # → .opentofu-version
teriac pin --provider terragrunt        # → .terragrunt-version
```

---

### Upgrade

```sh
teriac upgrade                          # upgrade active 1.6.3 → latest 1.6.x patch
teriac upgrade 1.9                      # install + use latest 1.9.x
teriac upgrade latest                   # install + use absolute latest
teriac upgrade --provider tofu
```

Also re-anchors `~/.teriac/bin` in PATH to ensure it takes precedence over any system-installed terraform.

---

### Remove

```sh
teriac remove 1.7.3
teriac rm 1.7.3 1.6.6                   # remove multiple
teriac rm 1.8.0 --provider tofu
```

Warns if you're removing the currently active version.

---

### Prune

Remove all non-active versions at once to free disk space.

```sh
teriac prune                            # remove everything except the active version
teriac prune --keep 2                   # keep the 2 most recent + the active version
teriac prune --provider tofu
teriac prune --yes                      # skip confirmation prompt
```

The active version is always kept regardless of `--keep`.

---

### Exec

Run a single command with a specific installed version **without** changing the active version. Useful for cross-version testing and CI.

```sh
teriac exec 1.9.0 -- version
teriac exec 1.8.0 -- plan -var="env=prod"
teriac exec 1.7.3 --provider tofu -- validate
```

Pass all terraform/tofu flags after `--`.

---

### Doctor

Run a full health check: store directories, active binaries, PATH order, PATH conflicts, and shell config.

```sh
teriac doctor
```

Example output:

```text
teriac doctor

Store
  ✔  ~/.teriac/store/terraform/ exists
  ✔  ~/.teriac/store/opentofu/ exists

Active versions
  ✔  terraform: active version is 1.9.0
  ✔  terraform: binary exists
  ✔  terraform: executes  (Terraform v1.9.0)
  –  tofu: not set up (no versions installed)

PATH
  ✔  ~/.teriac/bin is in PATH
  ✔  ~/.teriac/bin precedes system dirs in PATH
  ✔  'terraform' resolves to teriac-managed binary
  ✔  PATH block found in shell config (~/.zshrc)

Cache
  ✔  terraform version cache exists
  –  opentofu version cache not yet created

All checks passed. teriac is healthy.
```

Exits with code 1 if any issue is found.

---

### Terraform commands (via teriac)

All commands use the teriac-managed binary and accept extra terraform flags after `--`:

```sh
teriac init
teriac validate
teriac fmt
teriac fmt -- -recursive

teriac plan
teriac plan --file main.tf                        # extract targets from file
teriac plan --file main.tf --file network.tf      # multiple files
teriac plan --file main.tf -- -var="env=prod"     # with extra terraform flags

teriac apply --file main.tf -- -auto-approve
teriac destroy --file main.tf -- -auto-approve
```

`--file` parses `.tf` files and auto-generates `-target` flags for every `resource`, `data`, and `module` block found. Comments are stripped before parsing.

All commands support `--provider tofu` to use OpenTofu instead.

---

## OpenTofu support

Every command works with OpenTofu via `--provider tofu` (or `--provider opentofu`):

```sh
teriac install latest --provider tofu
teriac use 1.8.0 --provider tofu
teriac list --remote --provider tofu
teriac current --provider tofu
teriac plan --provider tofu
```

OpenTofu binaries are stored separately from Terraform in `~/.teriac/store/opentofu/` and activated as `~/.teriac/bin/tofu`.

---

## Terragrunt support

Terragrunt works the same way via `--provider terragrunt` (or `-p tg`):

```sh
teriac install latest -p tg
teriac use 1.2.1 -p tg
teriac list --remote -p tg
teriac pin -p tg                        # writes .terragrunt-version
teriac auto-switch -p tg
```

`teriac auto-switch -p tg` (and the shell hook) reads, in order: `.terragrunt-version`, `.tgswitchrc`, a `terragrunt` line in `.tool-versions`, then `terragrunt_version_constraint` in `terragrunt.hcl` / `root.hcl`.

Terraform also picks up `terraform_version_constraint` from `terragrunt.hcl` / `root.hcl`, so in a Terragrunt project one `cd` switches both tools:

```hcl
# terragrunt.hcl
terraform_version_constraint  = "~> 1.9"
terragrunt_version_constraint = ">= 1.0, < 2.0"
```

Terragrunt binaries live in `~/.teriac/store/terragrunt/` and are activated as `~/.teriac/bin/terragrunt`.

---

## Provider plugin cache

Share downloaded providers across all your projects, so each provider version downloads once instead of once per project:

```sh
teriac plugin-cache on                  # enable
teriac plugin-cache status              # show what's set
teriac plugin-cache off                 # remove what teriac added
```

This sets `plugin_cache_dir` in your Terraform CLI config (`~/.terraformrc`, or `%APPDATA%\terraform.rc` on Windows), with the cache in `~/.terraform.d/plugin-cache`. OpenTofu reads the same file unless you have a `~/.tofurc`, which teriac then updates too. teriac never changes a `plugin_cache_dir` you set yourself.

---

## Mirrors, proxies & offline use

Download from an internal mirror (Artifactory, Nexus, ...) instead of the public sites. Each variable replaces one host and keeps the rest of the path:

| Variable | Replaces | Used for |
|---|---|---|
| `TERIAC_HASHICORP_MIRROR` | `https://releases.hashicorp.com` | Terraform (downloads and version list) |
| `TERIAC_GITHUB_MIRROR` | `https://github.com` | OpenTofu and Terragrunt downloads |

```sh
export TERIAC_HASHICORP_MIRROR=https://artifactory.example.com/artifactory/hashicorp
export TERIAC_GITHUB_MIRROR=https://user:token@nexus.example.com/repository/github
```

Plain `http://` mirrors and credentials in the URL are supported. Checksums are still verified against the mirrored `SHA256SUMS` file.

OpenTofu and Terragrunt version lists come from the GitHub API. If it can't be reached, installing an exact version (`teriac install 1.8.0 -p tofu`) still works; `latest` needs the list. Set `GITHUB_TOKEN` to raise GitHub's limit of 60 requests an hour.

---

## Windows support

Everything works on Windows without administrator privileges:

- Store: `%USERPROFILE%\.teriac\`
- PATH: updated via `[Environment]::SetEnvironmentVariable("PATH", ..., "User")` (User scope, no admin)
- Shell hooks: PowerShell profile integration via `teriac shell-init powershell`

---

## Help

```sh
teriac --help
teriac <command> --help
```
