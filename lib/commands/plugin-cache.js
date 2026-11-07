'use strict'

const { pluginCache } = require('../modules/pluginCache');

exports.command = 'plugin-cache [action]'
exports.desc = 'Share downloaded providers across projects (on | off | status)'
exports.builder = (yargs) => {
  return yargs
    .positional('action', {
      describe: 'on, off or status',
      choices: ['on', 'off', 'status'],
      default: 'status',
    })
    .epilog([
      'Sets plugin_cache_dir in your Terraform CLI config (~/.terraformrc, or',
      '%APPDATA%\\terraform.rc on Windows), so each provider version downloads',
      'once instead of once per project. OpenTofu uses the same file unless you',
      'have a ~/.tofurc, which tfv then updates too.',
      '',
      'Examples:',
      '  tfv plugin-cache on',
      '  tfv plugin-cache status',
      '  tfv plugin-cache off',
    ].join('\n'))
}

exports.handler = (argv) => {
  pluginCache(argv.action);
}
