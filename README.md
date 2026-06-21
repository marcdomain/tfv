# tfv — Terraform & OpenTofu Version Manager for macOS, Linux & Windows

```
         _        ________        __
       _| |__   / _____|\ \      / /
      |_  ___\ | |___    \ \    / /
        | |    |  ___|    \ \  / /
        | |___ | |         \ \/ /
        \______\_|          \__/

        Happy terraforming! 😍🥂
    ---------------------------------
```

`tfv` lets you install, switch, and manage multiple versions of **Terraform** and **OpenTofu** without `sudo`. All binaries live in `~/.tfv/` — upgrading `tfv` itself never wipes your installed versions.

![tfv demo](demo.gif)

---

## Installation

```sh
npm install -g tfv
```

`tfv` automatically adds `~/.tfv/bin` to your PATH on install (shell configs + Windows User PATH). Restart your terminal once after install.

---

## How it works

```
npm install -g tfv
       │
       ▼
postInstall.js
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

```
~/.tfv/
  bin/
    terraform          ← active terraform binary (no sudo, no symlinks)
    tofu               ← active opentofu binary
  store/
    terraform/
      1.9.0            ← installed versions (binary renamed to version number)
      1.7.3
      arch.json        ← { "1.9.0": "arm64", "1.7.3": "amd64" }
    opentofu/
      1.8.0
      arch.json
  cache/
    terraform-versions.json   ← remote list cached for 1 hour
    opentofu-versions.json
  active.json          ← { "terraform": "1.9.0", "opentofu": null }
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

1. `.terraform-version` file in current directory
2. `terraform.tfstate` → `terraform_version` field
3. `required_version` in any `.tf` file — supports all constraint operators:
   `=`, `>=`, `>`, `<=`, `<`, `!=`, `~>`, and compound `">= 1.3, < 2.0"`

---

### Shell hook — auto-switch on `cd`

Wraps `cd` so that entering a directory automatically switches the terraform version — but **only if the directory looks like a terraform project**. Non-terraform folders have zero overhead (one filesystem check, no subprocess).

A directory is considered a terraform project if it contains:
- a `.terraform-version` file, **or**
- any `*.tf` files

```sh
cd ~/Downloads           # no .tf files → nothing happens
cd ~/projects/react-app  # no .tf files → nothing happens
cd ~/projects/infra      # has main.tf  → auto-switch runs silently
cd ~/projects/platform   # has .terraform-version → auto-switch runs silently
```

Setup (one-time, add to your shell config):

```sh
# Bash
echo 'eval "$(tfv shell-init bash)"' >> ~/.bashrc

# Zsh
echo 'eval "$(tfv shell-init zsh)"' >> ~/.zshrc

# Fish
echo 'tfv shell-init fish | source' >> ~/.config/fish/config.fish

# PowerShell
echo 'Invoke-Expression (tfv shell-init powershell | Out-String)' >> $PROFILE
```

After setup, entering a terraform project switches the version automatically — no manual `tfv as` needed.

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
```
Active terraform version: 1.9.0
Binary: /Users/you/.tfv/bin/terraform
Reported: Terraform v1.9.0
PATH OK — 'terraform' resolves to tfv-managed binary
```

---

### Pin version

Writes a `.terraform-version` file in the current directory so teammates get the same version via `tfv auto-switch`:

```sh
tfv pin                              # pin currently active version
tfv pin 1.9.0                        # pin a specific version
tfv pin --provider tofu
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
