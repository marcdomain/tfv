'use strict'

const { autoSwitch } = require('../modules/switch');

exports.command = 'auto-switch'
exports.aliases = ['as']
exports.desc = 'Auto-detect and switch to your project terraform version'
exports.builder = (yargs) => {
  return yargs
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default), tofu/opentofu, or terragrunt/tg',
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
      '       terragrunt: .terragrunt-version, .tgswitchrc, .tool-versions',
      '  2. terraform.tfstate',
      '  3. required_version in .tf files',
      '  4. terragrunt.hcl / root.hcl: terraform_version_constraint',
      '     (terragrunt: terragrunt_version_constraint)',
      'Examples:',
      '  teriac auto-switch',
      '  teriac as --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const { silent, provider, hook } = argv;
  if (silent) {
    console.log = () => {};
    console.warn = () => {};
  }
  if (hook) {
    // Terraform as before, plus OpenTofu / Terragrunt when the project pins them.
    await autoSwitch({ silent }, 'terraform');
    await autoSwitch({ silent, strict: true }, 'opentofu');
    await autoSwitch({ silent, strict: true }, 'terragrunt');
    return;
  }
  await autoSwitch({ silent }, provider);
}
