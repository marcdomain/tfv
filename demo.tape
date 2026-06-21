# tfv — demo tape
# Run with: vhs demo.tape

Output demo.gif

# ── Terminal settings ──────────────────────────────────────────────────────────
Set FontSize 14
Set Width 1000
Set Height 580
Set Theme "Catppuccin Mocha"
Set Shell "zsh"
Set Padding 24
Set TypingSpeed 40ms
Set PlaybackSpeed 1

# ══════════════════════════════════════════════════════════════════════════════
# 1. HELP
# ══════════════════════════════════════════════════════════════════════════════
Sleep 500ms
Type "tfv --help"
Enter
Sleep 3s

# ══════════════════════════════════════════════════════════════════════════════
# 2. INSTALL MULTIPLE VERSIONS
# ══════════════════════════════════════════════════════════════════════════════

# Install latest stable
Type "tfv install latest"
Enter
Sleep 5s

# Install a specific version
Type "tfv install 1.8.5"
Enter
Sleep 5s

# Install an older version using ^ (latest patch in series)
Type "tfv install 1.7.^"
Enter
Sleep 5s

# Install 1.6.x series
Type "tfv install 1.6.^"
Enter
Sleep 5s

# ══════════════════════════════════════════════════════════════════════════════
# 3. LIST INSTALLED VERSIONS
# ══════════════════════════════════════════════════════════════════════════════
Type "tfv list"
Enter
Sleep 2s

# ══════════════════════════════════════════════════════════════════════════════
# 4. SWITCH BETWEEN VERSIONS — show terraform version changes
# ══════════════════════════════════════════════════════════════════════════════

Type "tfv use 1.6.7"
Enter
Sleep 1500ms
Type "terraform version"
Enter
Sleep 1500ms

Type "tfv use 1.7.5"
Enter
Sleep 1500ms
Type "terraform version"
Enter
Sleep 1500ms

Type "tfv use 1.8.5"
Enter
Sleep 1500ms
Type "terraform version"
Enter
Sleep 1500ms

Type "tfv use latest"
Enter
Sleep 1500ms
Type "terraform version"
Enter
Sleep 2s

# ══════════════════════════════════════════════════════════════════════════════
# 5. CURRENT — active version + PATH status
# ══════════════════════════════════════════════════════════════════════════════
Type "tfv current"
Enter
Sleep 2s

# ══════════════════════════════════════════════════════════════════════════════
# 6. AUTO-SWITCH — reads required_version from .tf file
# ══════════════════════════════════════════════════════════════════════════════
Hide
Type "mkdir -p /tmp/tfv-demo-tf && printf 'terraform { required_version = \\042~> 1.7\\042 }\\n' > /tmp/tfv-demo-tf/versions.tf && cd /tmp/tfv-demo-tf"
Enter
Sleep 500ms
Type "clear"
Enter
Sleep 200ms
Show

Type "tfv auto-switch"
Enter
Sleep 2s

Type "terraform version"
Enter
Sleep 1500ms

Hide
Type "cd -"
Enter
Sleep 300ms
Type "clear"
Enter
Sleep 200ms
Show

# AUTO-SWITCH from .terraform-version file
Hide
Type "mkdir -p /tmp/tfv-demo-pin && echo '1.6.7' > /tmp/tfv-demo-pin/.terraform-version && cd /tmp/tfv-demo-pin"
Enter
Sleep 500ms
Type "clear"
Enter
Sleep 200ms
Show

Type "tfv auto-switch"
Enter
Sleep 2s

Type "terraform version"
Enter
Sleep 1500ms

Hide
Type "cd -"
Enter
Sleep 300ms
Type "clear"
Enter
Sleep 200ms
Show

# ══════════════════════════════════════════════════════════════════════════════
# 7. PIN — lock version for teammates
# ══════════════════════════════════════════════════════════════════════════════
Hide
Type "tfv use latest"
Enter
Sleep 500ms
Type "clear"
Enter
Sleep 200ms
Show

Type "tfv pin"
Enter
Sleep 500ms

Type "cat .terraform-version"
Enter
Sleep 1500ms

# ══════════════════════════════════════════════════════════════════════════════
# 8. UPGRADE — latest patch in current series
# ══════════════════════════════════════════════════════════════════════════════
Type "tfv use 1.8.5"
Enter
Sleep 1000ms

Type "tfv upgrade"
Enter
Sleep 5s

Type "terraform version"
Enter
Sleep 2s

# ══════════════════════════════════════════════════════════════════════════════
# 9. REMOVE versions
# ══════════════════════════════════════════════════════════════════════════════
Type "tfv remove 1.6.7"
Enter
Sleep 1s

Type "tfv list"
Enter
Sleep 2s

# ══════════════════════════════════════════════════════════════════════════════
# 10. OPENTOFU — --provider tofu switches to OpenTofu; omit for terraform default
# ══════════════════════════════════════════════════════════════════════════════

# No --provider needed for terraform (it's the default)
Type "tfv list"
Enter
Sleep 1500ms

# Add --provider tofu to target OpenTofu instead
Type "tfv install latest --provider tofu"
Enter
Sleep 5s

Type "tfv use latest --provider tofu"
Enter
Sleep 1500ms

Type "tfv current --provider tofu"
Enter
Sleep 1500ms

Type "tofu version"
Enter
Sleep 2s

# List available remote OpenTofu versions
Type "tfv list --remote --provider tofu"
Enter
Sleep 4s

# ══════════════════════════════════════════════════════════════════════════════
# END
# ══════════════════════════════════════════════════════════════════════════════
Sleep 2s
