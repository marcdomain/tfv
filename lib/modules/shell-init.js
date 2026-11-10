const { join } = require('path');
const { P_END, P_OK, P_ERROR, P_INFO } = require('../utils/colors');
const { HOME_DIR, shellHome, windowsHome } = require('../utils/paths');

// Where installed versions live, as each shell writes it (~/.teriac, or TERIAC_HOME).
const STORE = `${shellHome(HOME_DIR)}/store`;
const winHome = windowsHome(HOME_DIR);
const PS_STORE = winHome === HOME_DIR
  ? `Join-Path "${join(HOME_DIR, 'store')}" $provider`
  : `Join-Path $env:USERPROFILE "${winHome}\\store\\$provider"`;

const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish', 'powershell', 'pwsh'];

const BASH_ZSH_HOOK = `
# teriac - Terraform, OpenTofu & Terragrunt version manager: shell integration
# Add this to your shell config by running: eval "$(teriac shell-init <shell>)"
_teriac_has_pin() {
  for _teriac_f in .terraform-version .opentofu-version .tofu-version .tfswitchrc .tfswitch.toml .terragrunt-version .tgswitchrc terragrunt.hcl root.hcl; do
    [ -f "$_teriac_f" ] && return 0
  done
  if [ -f .tool-versions ] && grep -qE '^[[:space:]]*(terraform|opentofu|tofu|terragrunt)[[:space:]]' .tool-versions 2>/dev/null; then
    return 0
  fi
  find . -maxdepth 1 -name "*.tf" -print -quit 2>/dev/null | grep -q .
}

_teriac_auto_switch() {
  if _teriac_has_pin; then
    teriac auto-switch --hook --silent 2>/dev/null
  fi
}

# Hook into directory changes without touching cd
if [ -n "\${ZSH_VERSION:-}" ]; then
  autoload -Uz add-zsh-hook
  add-zsh-hook chpwd _teriac_auto_switch
elif [ -n "\${BASH_VERSION:-}" ]; then
  _teriac_prev_dir="\$PWD"
  _teriac_dir_check() {
    if [ "\$PWD" != "\$_teriac_prev_dir" ]; then
      _teriac_prev_dir="\$PWD"
      _teriac_auto_switch
    fi
  }
  PROMPT_COMMAND="\${PROMPT_COMMAND:+\${PROMPT_COMMAND}; }_teriac_dir_check"
fi

# Run for the current directory on shell startup
_teriac_auto_switch

# ── Tab completions ────────────────────────────────────────────────────────
_teriac_versions() {
  ls "${STORE}/\${1:-terraform}" 2>/dev/null | grep -v arch.json | sed 's/\\.exe\$//'
}

if [ -n "\${BASH_VERSION:-}" ]; then
  _teriac_complete() {
    local cur="\${COMP_WORDS[COMP_CWORD]}"
    local prev="\${COMP_WORDS[COMP_CWORD-1]}"
    local cmds="install i use auto-switch as list ls current which pin upgrade remove rm exec prune doctor plugin-cache shell-init fmt init validate plan apply destroy"
    case "\$prev" in
      use|exec|remove|rm|pin|upgrade|install|i)
        COMPREPLY=(\$(compgen -W "\$(_teriac_versions terraform) latest" -- "\$cur")) ;;
      --provider|-p)
        COMPREPLY=(\$(compgen -W "terraform tofu opentofu terragrunt tg" -- "\$cur")) ;;
      shell-init)
        COMPREPLY=(\$(compgen -W "bash zsh fish powershell pwsh" -- "\$cur")) ;;
      *)
        COMPREPLY=(\$(compgen -W "\$cmds" -- "\$cur")) ;;
    esac
  }
  complete -F _teriac_complete teriac
elif [ -n "\${ZSH_VERSION:-}" ]; then
  _teriac_complete() {
    local cmds
    cmds=(install i use auto-switch as list ls current which pin upgrade remove rm exec prune doctor plugin-cache shell-init fmt init validate plan apply destroy)
    local prev="\${words[CURRENT-1]}"
    case "\$prev" in
      use|exec|remove|rm|pin|upgrade|install|i)
        compadd -- \$(_teriac_versions terraform) latest ;;
      --provider|-p)
        compadd -- terraform tofu opentofu terragrunt tg ;;
      shell-init)
        compadd -- bash zsh fish powershell pwsh ;;
      *)
        compadd -- "\$cmds[@]" ;;
    esac
  }
  compdef _teriac_complete teriac 2>/dev/null
fi
`.trim();

const FISH_HOOK = `
# teriac - Terraform, OpenTofu & Terragrunt version manager: shell integration
# Add to ~/.config/fish/config.fish: teriac shell-init fish | source

function _teriac_has_pin
  for f in .terraform-version .opentofu-version .tofu-version .tfswitchrc .tfswitch.toml .terragrunt-version .tgswitchrc terragrunt.hcl root.hcl
    test -f $f; and return 0
  end
  if test -f .tool-versions; and grep -qE '^[[:space:]]*(terraform|opentofu|tofu|terragrunt)[[:space:]]' .tool-versions 2>/dev/null
    return 0
  end
  count *.tf >/dev/null 2>&1
end

function _teriac_auto_switch
  if _teriac_has_pin
    teriac auto-switch --hook --silent 2>/dev/null
  end
end

function _teriac_on_pwd --on-variable PWD
  _teriac_auto_switch
end

_teriac_auto_switch

# ── Tab completions ────────────────────────────────────────────────────────
function __teriac_installed_versions
  set provider terraform
  for i in (seq 1 (count $argv))
    if test "$argv[$i]" = "--provider" -o "$argv[$i]" = "-p"
      set next (math $i + 1)
      if test $next -le (count $argv)
        set p $argv[$next]
        if test "$p" = "tofu" -o "$p" = "opentofu"
          set provider opentofu
        else if test "$p" = "terragrunt" -o "$p" = "tg"
          set provider terragrunt
        end
      end
    end
  end
  ls "${STORE}/$provider" 2>/dev/null | grep -v arch.json | string replace -r '\\.exe$' ''
end

set -l teriac_commands install i use auto-switch as list ls current which pin upgrade remove rm exec prune doctor plugin-cache shell-init fmt init validate plan apply destroy

complete -c teriac -f
complete -c teriac -n 'not __fish_seen_subcommand_from $teriac_commands' -a "$teriac_commands"

for subcmd in use exec remove rm pin upgrade
  complete -c teriac -n "__fish_seen_subcommand_from $subcmd" -a '(__teriac_installed_versions (commandline -opc))' -d 'Installed version'
  complete -c teriac -n "__fish_seen_subcommand_from $subcmd" -a 'latest' -d 'Latest version'
end

complete -c teriac -n "__fish_seen_subcommand_from install i" -a '(__teriac_installed_versions (commandline -opc))' -d 'Installed version'
complete -c teriac -n "__fish_seen_subcommand_from install i" -a 'latest' -d 'Latest version'

complete -c teriac -l provider -s p -r -a 'terraform tofu opentofu terragrunt tg' -d 'Provider'
complete -c teriac -n "__fish_seen_subcommand_from shell-init" -a 'bash zsh fish powershell pwsh' -d 'Shell'

`.trim();

const POWERSHELL_HOOK = `
# teriac - Terraform, OpenTofu & Terragrunt version manager: shell integration
# Add to your PowerShell profile ($PROFILE):
#   Invoke-Expression (teriac shell-init powershell | Out-String)

function global:_TeriacHasPin {
  foreach ($f in '.terraform-version', '.opentofu-version', '.tofu-version', '.tfswitchrc', '.tfswitch.toml', '.terragrunt-version', '.tgswitchrc', 'terragrunt.hcl', 'root.hcl') {
    if (Test-Path $f) { return $true }
  }
  if ((Test-Path '.tool-versions') -and (Select-String -Path '.tool-versions' -Pattern '^\\s*(terraform|opentofu|tofu|terragrunt)\\s' -Quiet)) {
    return $true
  }
  return [bool](Get-ChildItem -Filter '*.tf' -ErrorAction SilentlyContinue)
}

# Hook into directory changes without touching cd
$global:_TeriacLastDir = $PWD.Path
$global:_TeriacUserPrompt = if (Test-Path function:prompt) { $function:prompt } else { $null }
function global:prompt {
  $currentPath = $PWD.Path
  if ($currentPath -ne $global:_TeriacLastDir) {
    $global:_TeriacLastDir = $currentPath
    if (_TeriacHasPin) {
      teriac auto-switch --hook --silent 2>$null
    }
  }
  if ($global:_TeriacUserPrompt) { & $global:_TeriacUserPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)> " }
}

# Run for current directory on shell startup
if (_TeriacHasPin) {
  teriac auto-switch --hook --silent 2>$null
}

# ── Tab completions ────────────────────────────────────────────────────────
Register-ArgumentCompleter -Native -CommandName teriac -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $commands = @('install','i','use','auto-switch','as','list','ls','current','which','pin','upgrade','remove','rm','exec','prune','doctor','plugin-cache','shell-init','fmt','init','validate','plan','apply','destroy')
  $elements = $commandAst.CommandElements
  $prev = if ($elements.Count -ge 2) { $elements[$elements.Count - 2].ToString() } else { '' }

  # Detect --provider / -p anywhere on the line
  $provider = 'terraform'
  for ($i = 1; $i -lt $elements.Count - 1; $i++) {
    if ($elements[$i].ToString() -in '--provider','-p') {
      $pval = $elements[$i+1].ToString()
      if ($pval -in 'tofu','opentofu') { $provider = 'opentofu' }
      elseif ($pval -in 'terragrunt','tg') { $provider = 'terragrunt' }
    }
  }

  $storeDir = ${PS_STORE}
  $installed = if (Test-Path $storeDir) {
    Get-ChildItem $storeDir -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne 'arch.json' } |
      ForEach-Object { $_.Name -replace '\\.exe$','' }
  } else { @() }

  $completions = switch ($prev) {
    { $_ -in 'use','exec','remove','rm','pin','upgrade','install','i' } { @($installed) + 'latest' }
    { $_ -in '--provider','-p' }  { 'terraform','tofu','opentofu','terragrunt','tg' }
    'shell-init'                  { 'bash','zsh','fish','powershell','pwsh' }
    default                       { $commands }
  }

  $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`.trim();

const INSTALL_INSTRUCTIONS = {
  bash: `
${'\x1b[32m\x1b[1m'}Shell hook generated for bash.${'\x1b[0m'}
To activate, add this to your ~/.bashrc:
  eval "$(teriac shell-init bash)"
Then restart your terminal or run: source ~/.bashrc
`,
  zsh: `
${'\x1b[32m\x1b[1m'}Shell hook generated for zsh.${'\x1b[0m'}
To activate, add this to your ~/.zshrc:
  eval "$(teriac shell-init zsh)"
Then restart your terminal or run: source ~/.zshrc
`,
  fish: `
${'\x1b[32m\x1b[1m'}Shell hook generated for fish.${'\x1b[0m'}
To activate, add this to your ~/.config/fish/config.fish:
  teriac shell-init fish | source
Then restart your terminal or run: source ~/.config/fish/config.fish
`,
  powershell: `
${'\x1b[32m\x1b[1m'}Shell hook generated for PowerShell.${'\x1b[0m'}
To activate, add this to your $PROFILE:
  Invoke-Expression (teriac shell-init powershell | Out-String)
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

  // Only print install instructions when stdout is a TTY (i.e. the user ran
  // teriac shell-init directly). When called inside $() for eval, stdout is a
  // pipe so isTTY is falsy — suppress the message to avoid it printing on
  // every `source ~/.zshrc`.
  const key = s === 'pwsh' ? 'powershell' : s;
  if (INSTALL_INSTRUCTIONS[key] && process.stdout.isTTY) {
    process.stderr.write(INSTALL_INSTRUCTIONS[key] + '\n');
  }
};
