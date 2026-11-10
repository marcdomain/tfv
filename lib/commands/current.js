'use strict'

const { current } = require('../modules/current');

exports.command = 'current'
exports.aliases = ['which']
exports.desc = 'Show the currently active terraform, opentofu or terragrunt version'
exports.builder = (yargs) => {
  return yargs
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default), tofu/opentofu, or terragrunt/tg',
      type: 'string',
      default: 'terraform',
    })
    .epilog([
      'Examples:',
      '  teriac current',
      '  teriac which --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  await current(argv.provider);
}
