'use strict'

const { runTerraformCommand } = require('../modules/terraform-command');

exports.command = 'fmt'
exports.desc = 'Run terraform fmt. Accepts all terraform flags after --'
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
      '  tfv fmt',
      '  tfv fmt -- -recursive',
      '  tfv fmt -- -check',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const extraArgs = argv._.slice(1);
  await runTerraformCommand('fmt', null, extraArgs, argv.provider);
}
