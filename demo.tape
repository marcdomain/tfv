# teriac — demo tape
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
Type "teriac --help"
Enter
Sleep 3s

# ══════════════════════════════════════════════════════════════════════════════
# 2. INSTALL MULTIPLE VERSIONS
# ══════════════════════════════════════════════════════════════════════════════

# Install latest stable
Type "teriac install latest"
Enter
Sleep 5s

# Install a specific version
Type "teriac install 1.8.5"
Enter
Sleep 5s

# Install an older version using ^ (latest patch in series)
Type "teriac install 1.7.^"
Enter
Sleep 5s

# Install 1.6.x series
Type "teriac install 1.6.^"
Enter
Sleep 5s

# ══════════════════════════════════════════════════════════════════════════════
# 3. LIST INSTALLED VERSIONS
# ══════════════════════════════════════════════════════════════════════════════
Type "teriac list"
Enter
Sleep 2s

# ══════════════════════════════════════════════════════════════════════════════
# 4. SWITCH BETWEEN VERSIONS — show terraform version changes
# ══════════════════════════════════════════════════════════════════════════════

Type "teriac use 1.6.6"
Enter
Sleep 1500ms
Type "terraform version"
Enter
Sleep 1500ms

Type "teriac use 1.7.5"
Enter
Sleep 1500ms
Type "terraform version"
Enter
Sleep 1500ms

Type "teriac use 1.8.5"
Enter
Sleep 1500ms
Type "terraform version"
Enter
Sleep 1500ms

Type "teriac use latest"
Enter
Sleep 1500ms
Type "terraform version"
Enter
Sleep 2s

# ══════════════════════════════════════════════════════════════════════════════
# 5. CURRENT — active version + PATH status
# ══════════════════════════════════════════════════════════════════════════════
Type "teriac current"
Enter
Sleep 2s

# ══════════════════════════════════════════════════════════════════════════════
# 6. AUTO-SWITCH — reads required_version from .tf file
# ══════════════════════════════════════════════════════════════════════════════
Hide
Type "mkdir -p /tmp/teriac-demo-tf && printf 'terraform { required_version = \\042~> 1.7\\042 }\\n' > /tmp/teriac-demo-tf/versions.tf && cd /tmp/teriac-demo-tf"
Enter
Sleep 500ms
Type "clear"
Enter
Sleep 200ms
Show

Type "teriac auto-switch"
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
Type "mkdir -p /tmp/teriac-demo-pin && echo '1.6.6' > /tmp/teriac-demo-pin/.terraform-version && cd /tmp/teriac-demo-pin"
Enter
Sleep 500ms
Type "clear"
Enter
Sleep 200ms
Show

Type "teriac auto-switch"
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
Type "teriac use latest"
Enter
Sleep 500ms
Type "clear"
Enter
Sleep 200ms
Show

Type "teriac pin"
Enter
Sleep 500ms

Type "cat .terraform-version"
Enter
Sleep 1500ms

# ══════════════════════════════════════════════════════════════════════════════
# 8. UPGRADE — latest patch in current series
# ══════════════════════════════════════════════════════════════════════════════
Type "teriac use 1.8.5"
Enter
Sleep 1000ms

Type "teriac upgrade"
Enter
Sleep 5s

Type "terraform version"
Enter
Sleep 2s

# ══════════════════════════════════════════════════════════════════════════════
# 9. REMOVE versions
# ══════════════════════════════════════════════════════════════════════════════
Type "teriac remove 1.6.6"
Enter
Sleep 1s

Type "teriac list"
Enter
Sleep 2s

# ══════════════════════════════════════════════════════════════════════════════
# 10. OPENTOFU — --provider tofu switches to OpenTofu; omit for terraform default
# ══════════════════════════════════════════════════════════════════════════════

# No --provider needed for terraform (it's the default)
Type "teriac list"
Enter
Sleep 1500ms

# Add --provider tofu to target OpenTofu instead
Type "teriac install latest --provider tofu"
Enter
Sleep 5s

Type "teriac use latest --provider tofu"
Enter
Sleep 1500ms

Type "teriac current --provider tofu"
Enter
Sleep 1500ms

Type "tofu version"
Enter
Sleep 2s

# List available remote OpenTofu versions
Type "teriac list --remote --provider tofu"
Enter
Sleep 4s

# ══════════════════════════════════════════════════════════════════════════════
# END
# ══════════════════════════════════════════════════════════════════════════════
Sleep 2s
