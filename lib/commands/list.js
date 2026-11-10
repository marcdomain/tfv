'use strict'

const { list } = require('../modules/list');

exports.command = 'list'
exports.aliases = ['ls']
exports.desc = 'List installed or available terraform/opentofu/terragrunt versions'
exports.builder = (yargs) => {
  return yargs
    .option('local', {
      alias: 'l',
      describe: 'List versions installed locally (default)',
      type: 'boolean',
      default: true,
    })
    .option('remote', {
      alias: 'r',
      describe: 'List all available remote versions',
      type: 'boolean',
    })
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default), tofu/opentofu, or terragrunt/tg',
      type: 'string',
      default: 'terraform',
    })
    .epilog([
      'Examples:',
      '  teriac ls                              List locally installed terraform versions',
      '  teriac ls --remote                     List all available terraform versions',
      '  teriac ls --remote --provider tofu     List all available opentofu versions',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const { local, remote, provider } = argv;
  await list(local, remote, provider);
}
