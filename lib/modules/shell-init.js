const { P_END, P_OK, P_ERROR, P_INFO } = require('../utils/colors');

const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish', 'powershell', 'pwsh'];

const BASH_ZSH_HOOK = `
# tfv - terraform version manager shell integration
# Add this to your shell config by running: eval "$(tfv shell-init <shell>)"
_tfv_auto_switch() {
  if [ -f ".terraform-version" ] || ls *.tf 2>/dev/null | head -1 >/dev/null 2>&1; then
    tfv auto-switch --silent 2>/dev/null
  fi
}

_tfv_cd() {
  builtin cd "$@" && _tfv_auto_switch
}

alias cd='_tfv_cd'

# Run for the current directory on shell startup
_tfv_auto_switch
`.trim();

const FISH_HOOK = `
# tfv - terraform version manager shell integration
# Add to ~/.config/fish/config.fish: tfv shell-init fish | source

function _tfv_auto_switch
  if test -f .terraform-version; or count *.tf >/dev/null 2>&1
    tfv auto-switch --silent 2>/dev/null
  end
end

function cd
  builtin cd $argv
  _tfv_auto_switch
end

_tfv_auto_switch
`.trim();

const POWERSHELL_HOOK = `
# tfv - terraform version manager shell integration
# Add to your PowerShell profile ($PROFILE):
#   Invoke-Expression (tfv shell-init powershell | Out-String)

function global:Set-LocationWithTfv {
  param([string]$Path = $PWD)
  Set-Location $Path
  if ((Test-Path ".terraform-version") -or (Get-ChildItem -Filter "*.tf" -ErrorAction SilentlyContinue)) {
    tfv auto-switch --silent 2>$null
  }
}

Remove-Item -Path Alias:cd -Force -ErrorAction SilentlyContinue
Set-Alias -Name cd -Value Set-LocationWithTfv -Scope Global -Force

# Run for current directory on shell startup
Set-LocationWithTfv -Path $PWD
`.trim();

const INSTALL_INSTRUCTIONS = {
  bash: `
${'\x1b[32m\x1b[1m'}Shell hook generated for bash.${'\x1b[0m'}
To activate, add this to your ~/.bashrc:
  eval "$(tfv shell-init bash)"
Then restart your terminal or run: source ~/.bashrc
`,
  zsh: `
${'\x1b[32m\x1b[1m'}Shell hook generated for zsh.${'\x1b[0m'}
To activate, add this to your ~/.zshrc:
  eval "$(tfv shell-init zsh)"
Then restart your terminal or run: source ~/.zshrc
`,
  fish: `
${'\x1b[32m\x1b[1m'}Shell hook generated for fish.${'\x1b[0m'}
To activate, add this to your ~/.config/fish/config.fish:
  tfv shell-init fish | source
Then restart your terminal or run: source ~/.config/fish/config.fish
`,
  powershell: `
${'\x1b[32m\x1b[1m'}Shell hook generated for PowerShell.${'\x1b[0m'}
To activate, add this to your $PROFILE:
  Invoke-Expression (tfv shell-init powershell | Out-String)
Then restart PowerShell or run: . $PROFILE
`,
};

exports.shellInit = (shell) => {
  const s = (shell || '').toLowerCase().trim();

  if (!SUPPORTED_SHELLS.includes(s)) {
    console.error(`${P_ERROR}Unsupported shell: ${shell}${P_END}`);
    console.error(`Supported shells: ${SUPPORTED_SHELLS.join(', ')}`);
    process.exit(1);
  }

  // Print the hook script to stdout (intended to be eval'd)
  if (s === 'fish') {
    process.stdout.write(FISH_HOOK + '\n');
  } else if (s === 'powershell' || s === 'pwsh') {
    process.stdout.write(POWERSHELL_HOOK + '\n');
  } else {
    // bash and zsh use the same hook
    process.stdout.write(BASH_ZSH_HOOK + '\n');
  }

  // Print install instructions to stderr so they don't get eval'd
  const key = s === 'pwsh' ? 'powershell' : s;
  if (INSTALL_INSTRUCTIONS[key]) {
    process.stderr.write(INSTALL_INSTRUCTIONS[key] + '\n');
  }
};
