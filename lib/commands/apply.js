'use strict'

const {runTerraformCommand} = require('../modules/terraform-command');

exports.command = 'apply'
exports.desc = 'Run terraform apply with optional file-based targets.\n'
exports.builder = (yargs) => {
  return yargs
    .option('file', {
      alias: 'f',
      describe: 'Terraform file(s) to extract targets from',
      type: 'array',
    })
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default) or tofu/opentofu',
      type: 'string',
      default: 'terraform',
    })
    .epilog('Accepts all terraform flags after --\nExample:\n tfv apply --file main.tf --file network.tf -- -auto-approve -target=<TARGET> -var="env=prod"')
}

exports.handler = async (argv) => {
  const {file, _, provider} = argv;
  const extraArgs = _.slice(1);
  await runTerraformCommand('apply', file, extraArgs, provider);
}
