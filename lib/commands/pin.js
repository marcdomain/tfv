'use strict'

const { pin } = require('../modules/pin');

exports.command = 'pin [ver]'
exports.desc = 'Pin the active (or specified) version to a .terraform-version file'
exports.builder = (yargs) => {
  return yargs
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default) or tofu/opentofu',
      type: 'string',
      default: 'terraform',
    })
    .epilog([
      'Creates a .terraform-version file in the current directory.',
      'Examples:',
      '  tfv pin               Pin currently active version',
      '  tfv pin 1.7.3         Pin a specific version',
      '  tfv pin --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  await pin(argv.ver, argv.provider);
}
