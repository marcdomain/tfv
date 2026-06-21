'use strict'

const { exec } = require('../modules/exec');

exports.command = 'exec <ver>'
exports.desc = 'Run a terraform/tofu command with a specific version without switching the active version'
exports.builder = (yargs) => {
  return yargs
    .positional('ver', {
      describe: 'Installed version to use for this run',
      type: 'string',
    })
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default) or tofu/opentofu',
      type: 'string',
      default: 'terraform',
    })
    .epilog([
      'Pass terraform/tofu args after --',
      '',
      'Examples:',
      '  tfv exec 1.9.0 -- version',
      '  tfv exec 1.8.0 -- plan -var="env=prod"',
      '  tfv exec 1.7.3 --provider tofu -- validate',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const { ver, provider, _ } = argv;
  const extraArgs = _.slice(1);
  await exec(ver, extraArgs, provider);
}
