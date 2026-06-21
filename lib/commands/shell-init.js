'use strict'

const { shellInit } = require('../modules/shell-init');

exports.command = 'shell-init <shell>'
exports.desc = 'Generate shell hook for automatic version switching on cd'
exports.builder = (yargs) => {
  return yargs
    .positional('shell', {
      describe: 'Shell to generate hook for',
      choices: ['bash', 'zsh', 'fish', 'powershell', 'pwsh'],
    })
    .epilog([
      'Outputs a shell script to stdout intended to be eval\'d.',
      'Setup instructions are printed to stderr.',
      '',
      'Bash/Zsh:       eval "$(tfv shell-init zsh)"     # add to ~/.zshrc',
      'Fish:           tfv shell-init fish | source      # add to config.fish',
      'PowerShell:     Invoke-Expression (tfv shell-init powershell | Out-String)',
    ].join('\n'))
}

exports.handler = (argv) => {
  shellInit(argv.shell);
}
