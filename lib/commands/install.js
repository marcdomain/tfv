'use strict'

const { install } = require('../modules/install');

exports.command = 'install <ver>'
exports.aliases = ['i']
exports.desc = 'Install a terraform or opentofu version'
exports.builder = (yargs) => {
  return yargs
    .option('arch', {
      alias: 'a',
      describe: 'Specify system architecture (arm64, amd64, etc). Defaults to your system arch.',
      type: 'string',
      default: '',
    })
    .option('provider', {
      alias: 'p',
      describe: 'Provider to install: terraform (default) or tofu/opentofu',
      type: 'string',
      default: 'terraform',
    })
    .epilog([
      'Version formats: latest, x.x.x (exact), x^ (latest major), x.x.^ (latest minor)',
      'Examples:',
      '  tfv install latest',
      '  tfv install 1.7.3',
      '  tfv install 1.7.^',
      '  tfv install latest --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const { ver, arch, provider } = argv;
  await install(ver, arch, provider);
}
