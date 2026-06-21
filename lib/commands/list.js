'use strict'

const { list } = require('../modules/list');

exports.command = 'list'
exports.aliases = ['ls']
exports.desc = 'List installed or available terraform/opentofu versions'
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
      describe: 'Provider: terraform (default) or tofu/opentofu',
      type: 'string',
      default: 'terraform',
    })
    .epilog([
      'Examples:',
      '  tfv ls                              List locally installed terraform versions',
      '  tfv ls --remote                     List all available terraform versions',
      '  tfv ls --remote --provider tofu     List all available opentofu versions',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const { local, remote, provider } = argv;
  await list(local, remote, provider);
}
