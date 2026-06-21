'use strict'

const { runTerraformCommand } = require('../modules/terraform-command');

exports.command = 'init'
exports.desc = 'Run terraform init. Accepts all terraform flags after --'
exports.builder = (yargs) => {
  return yargs
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default) or tofu/opentofu',
      type: 'string',
      default: 'terraform',
    })
    .epilog([
      'Examples:',
      '  tfv init',
      '  tfv init -- -upgrade',
      '  tfv init -- -backend-config=backend.hcl',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const extraArgs = argv._.slice(1);
  await runTerraformCommand('init', null, extraArgs, argv.provider);
}
