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
    .option('hook', {
      describe: 'Switch every provider the project pins (used by shell hooks)',
      type: 'boolean',
      default: false,
      hidden: true,
    })
    .epilog([
      'Reads version from (in priority order):',
      '  1. Version files:',
      '       terraform: .terraform-version, .tfswitchrc, .tfswitch.toml, .tool-versions',
      '       tofu:      .opentofu-version, .tofu-version, .tool-versions, .terraform-version',
      '  2. terraform.tfstate',
      '  3. required_version in .tf files',
      'Examples:',
      '  tfv auto-switch',
      '  tfv as --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const { silent, provider, hook } = argv;
  if (silent) {
    console.log = () => {};
    console.warn = () => {};
  }
  if (hook) {
    // Terraform as before, plus OpenTofu when the project pins it explicitly.
    await autoSwitch({ silent }, 'terraform');
    await autoSwitch({ silent, strict: true }, 'opentofu');
    return;
  }
  await autoSwitch({ silent }, provider);
}
