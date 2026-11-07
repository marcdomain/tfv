'use strict'

const { use } = require('../modules/use');

exports.command = 'use <ver>'
exports.desc = 'Switch to a specified terraform, opentofu or terragrunt version'
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
      '  tfv use 1.7.3',
      '  tfv use latest',
      '  tfv use 1.7.3 --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const { ver, provider } = argv;
  await use(ver, provider);
}
