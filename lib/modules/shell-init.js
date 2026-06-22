const { P_END, P_OK, P_ERROR, P_INFO } = require('../utils/colors');

const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish', 'powershell', 'pwsh'];

const BASH_ZSH_HOOK = `
# tfv - terraform version manager shell integration
# Add this to your shell config by running: eval "$(tfv shell-init <shell>)"
_tfv_auto_switch() {
  if [ -f ".terraform-version" ] || find . -maxdepth 1 -name "*.tf" -print -quit 2>/dev/null | grep -q .; then
    tfv auto-switch --silent 2>/dev/null
  fi
}

_tfv_cd() {
  builtin cd "$@" && _tfv_auto_switch
}

alias cd='_tfv_cd'

# Run for the current directory on shell startup
_tfv_auto_switch

# ── Tab completions ────────────────────────────────────────────────────────
_tfv_versions() {
  ls "\$HOME/.tfv/store/\${1:-terraform}" 2>/dev/null | grep -v arch.json | sed 's/\\.exe\$//'
}

if [ -n "\${BASH_VERSION:-}" ]; then
  _tfv_complete() {
    local cur="\${COMP_WORDS[COMP_CWORD]}"
    local prev="\${COMP_WORDS[COMP_CWORD-1]}"
    local cmds="install i use auto-switch as list ls current which pin upgrade remove rm exec prune doctor shell-init fmt init validate plan apply destroy"
    case "\$prev" in
      use|exec|remove|rm|pin|upgrade|install|i)
        COMPREPLY=(\$(compgen -W "\$(_tfv_versions terraform) latest" -- "\$cur")) ;;
      --provider|-p)
        COMPREPLY=(\$(compgen -W "terraform tofu opentofu" -- "\$cur")) ;;
      shell-init)
        COMPREPLY=(\$(compgen -W "bash zsh fish powershell pwsh" -- "\$cur")) ;;
      *)
        COMPREPLY=(\$(compgen -W "\$cmds" -- "\$cur")) ;;
    esac
  }
  complete -F _tfv_complete tfv
elif [ -n "\${ZSH_VERSION:-}" ]; then
  _tfv_complete() {
    local cmds
    cmds=(install i use auto-switch as list ls current which pin upgrade remove rm exec prune doctor shell-init fmt init validate plan apply destroy)
    local prev="\${words[CURRENT-1]}"
    case "\$prev" in
      use|exec|remove|rm|pin|upgrade|install|i)
        compadd -- \$(_tfv_versions terraform) latest ;;
      --provider|-p)
        compadd -- terraform tofu opentofu ;;
      shell-init)
        compadd -- bash zsh fish powershell pwsh ;;
      *)
        compadd -- "\$cmds[@]" ;;
    esac
  }
  compdef _tfv_complete tfv 2>/dev/null
  compdef _tfv_cd=cd 2>/dev/null
fi
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

# ── Tab completions ────────────────────────────────────────────────────────
function __tfv_installed_versions
  set provider terraform
  for i in (seq 1 (count $argv))
    if test "$argv[$i]" = "--provider" -o "$argv[$i]" = "-p"
      set next (math $i + 1)
      if test $next -le (count $argv)
        set p $argv[$next]
        if test "$p" = "tofu" -o "$p" = "opentofu"
          set provider opentofu
        end
      end
    end
  end
  ls $HOME/.tfv/store/$provider 2>/dev/null | grep -v arch.json | string replace -r '\\.exe$' ''
end

set -l tfv_commands install i use auto-switch as list ls current which pin upgrade remove rm exec prune doctor shell-init fmt init validate plan apply destroy

complete -c tfv -f
complete -c tfv -n 'not __fish_seen_subcommand_from $tfv_commands' -a "$tfv_commands"

for subcmd in use exec remove rm pin upgrade
  complete -c tfv -n "__fish_seen_subcommand_from $subcmd" -a '(__tfv_installed_versions (commandline -opc))' -d 'Installed version'
  complete -c tfv -n "__fish_seen_subcommand_from $subcmd" -a 'latest' -d 'Latest version'
end

complete -c tfv -n "__fish_seen_subcommand_from install i" -a '(__tfv_installed_versions (commandline -opc))' -d 'Installed version'
complete -c tfv -n "__fish_seen_subcommand_from install i" -a 'latest' -d 'Latest version'

complete -c tfv -l provider -s p -r -a 'terraform tofu opentofu' -d 'Provider'
complete -c tfv -n "__fish_seen_subcommand_from shell-init" -a 'bash zsh fish powershell pwsh' -d 'Shell'
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

# ── Tab completions ────────────────────────────────────────────────────────
Register-ArgumentCompleter -Native -CommandName tfv -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $commands = @('install','i','use','auto-switch','as','list','ls','current','which','pin','upgrade','remove','rm','exec','prune','doctor','shell-init','fmt','init','validate','plan','apply','destroy')
  $elements = $commandAst.CommandElements
  $prev = if ($elements.Count -ge 2) { $elements[$elements.Count - 2].ToString() } else { '' }

  # Detect --provider / -p anywhere on the line
  $provider = 'terraform'
  for ($i = 1; $i -lt $elements.Count - 1; $i++) {
    if ($elements[$i].ToString() -in '--provider','-p') {
      $pval = $elements[$i+1].ToString()
      if ($pval -in 'tofu','opentofu') { $provider = 'opentofu' }
    }
  }

  $storeDir = Join-Path $env:USERPROFILE ".tfv\\store\\$provider"
  $installed = if (Test-Path $storeDir) {
    Get-ChildItem $storeDir -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne 'arch.json' } |
      ForEach-Object { $_.Name -replace '\\.exe$','' }
  } else { @() }

  $completions = switch ($prev) {
    { $_ -in 'use','exec','remove','rm','pin','upgrade','install','i' } { @($installed) + 'latest' }
    { $_ -in '--provider','-p' }  { 'terraform','tofu','opentofu' }
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

  // Only print install instructions when stdout is a TTY (i.e. the user ran
  // tfv shell-init directly). When called inside $() for eval, stdout is a
  // pipe so isTTY is falsy — suppress the message to avoid it printing on
  // every `source ~/.zshrc`.
  const key = s === 'pwsh' ? 'powershell' : s;
  if (INSTALL_INSTRUCTIONS[key] && process.stdout.isTTY) {
    process.stderr.write(INSTALL_INSTRUCTIONS[key] + '\n');
  }
};
