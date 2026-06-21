'use strict'

const { remove } = require('../modules/remove');

exports.command = 'remove <ver>'
exports.aliases = ['rm']
exports.desc = 'Remove terraform/opentofu versions from tfv store'
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
      '  tfv rm 1.5.7 1.4.6',
      '  tfv rm 1.7.3 --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const versions = argv._.slice(1);
  const { provider } = argv;
  await remove(versions, provider);
}
