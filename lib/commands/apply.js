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
    .epilog('Accepts all terraform flags after --\nExample:\n tfv apply --file main.tf --file network.tf -- -auto-approve -target=<TARGET> -var="env=prod"')
}

exports.handler = async (argv) => {
  const {file, _} = argv;
  // Extra args come after -- in the command line
  const extraArgs = _.slice(1);
  await runTerraformCommand('apply', file, extraArgs);
}
