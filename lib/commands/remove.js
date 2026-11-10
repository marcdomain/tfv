'use strict'

const { remove } = require('../modules/remove');

exports.command = 'remove <ver..>'
exports.aliases = ['rm']
exports.desc = 'Remove terraform/opentofu/terragrunt versions from teriac store'
exports.builder = (yargs) => {
  return yargs
    .positional('ver', { type: 'string', array: true, describe: 'Versions to remove' })
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default), tofu/opentofu, or terragrunt/tg',
      type: 'string',
      default: 'terraform',
    })
    .epilog([
      'Examples:',
      '  teriac rm 1.5.7 1.4.6',
      '  teriac rm 1.7.3 --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const versions = [].concat(argv.ver);
  const { provider } = argv;
  await remove(versions, provider);
}
