'use strict'

const { runTerraformCommand } = require('../modules/terraform-command');

exports.command = 'validate'
exports.desc = 'Run terraform validate. Accepts all terraform flags after --'
exports.builder = (yargs) => {
  return yargs
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default) or tofu/opentofu',
      type: 'string',
      default: 'terraform',
    })
    .epilog('Example: tfv validate -- -json')
}

exports.handler = async (argv) => {
  const extraArgs = argv._.slice(1);
  await runTerraformCommand('validate', null, extraArgs, argv.provider);
}
