'use strict'

const { pin } = require('../modules/pin');

exports.command = 'pin [ver]'
exports.desc = 'Pin the active (or specified) version to a version file'
exports.builder = (yargs) => {
  return yargs
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default), tofu/opentofu, or terragrunt/tg',
      type: 'string',
      default: 'terraform',
    })
    .epilog([
      'Writes .terraform-version, .opentofu-version or .terragrunt-version in the current directory.',
      'Examples:',
      '  tfv pin               Pin currently active version',
      '  tfv pin 1.7.3         Pin a specific version',
      '  tfv pin --provider tofu   Writes .opentofu-version',
      '  tfv pin -p tg             Writes .terragrunt-version',
    ].join('\n'))
}

exports.handler = async (argv) => {
  await pin(argv.ver, argv.provider);
}
