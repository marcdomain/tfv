'use strict'

const { autoSwitch } = require('../modules/switch');

exports.command = 'auto-switch'
exports.aliases = ['as']
exports.desc = 'Auto-detect and switch to your project terraform version'
exports.builder = (yargs) => {
  return yargs
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default) or tofu/opentofu',
      type: 'string',
      default: 'terraform',
    })
    .option('silent', {
      alias: 's',
      describe: 'Suppress output (used by shell hooks)',
      type: 'boolean',
      default: false,
    })
    .epilog([
      'Reads version from (in priority order):',
      '  1. .terraform-version file',
      '  2. terraform.tfstate',
      '  3. required_version in .tf files',
      'Examples:',
      '  tfv auto-switch',
      '  tfv as --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const { silent, provider } = argv;
  if (silent) {
    console.log = () => {};
    console.warn = () => {};
  }
  await autoSwitch({ silent }, provider);
}
