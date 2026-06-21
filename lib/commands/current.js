'use strict'

const { current } = require('../modules/current');

exports.command = 'current'
exports.aliases = ['which']
exports.desc = 'Show the currently active terraform or opentofu version'
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
      '  tfv current',
      '  tfv which --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  await current(argv.provider);
}
