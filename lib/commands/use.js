'use strict'

const { use } = require('../modules/use');

exports.command = 'use <ver>'
exports.desc = 'Switch to a specified terraform, opentofu or terragrunt version'
exports.builder = (yargs) => {
  return yargs
    .positional('ver', { type: 'string', describe: 'Version, e.g. 1.10.2, 1.10, 1.7.^ or latest' })
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default), tofu/opentofu, or terragrunt/tg',
      type: 'string',
      default: 'terraform',
    })
    .epilog([
      'Examples:',
      '  teriac use 1.7.3',
      '  teriac use latest',
      '  teriac use 1.7.3 --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const { ver, provider } = argv;
  await use(ver, provider);
}
