'use strict'

const { upgrade } = require('../modules/upgrade');

exports.command = 'upgrade [ver]'
exports.desc = 'Upgrade to the latest patch version in the active (or given) series'
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
      '  teriac upgrade               Upgrade active 1.6.x → latest 1.6.x patch',
      '  teriac upgrade 1.8           Install + use latest 1.8.x',
      '  teriac upgrade latest        Install + use absolute latest version',
      '  teriac upgrade --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  await upgrade(argv.ver, argv.provider);
}
