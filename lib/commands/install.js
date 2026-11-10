'use strict'

const { install } = require('../modules/install');

exports.command = 'install <ver>'
exports.aliases = ['i']
exports.desc = 'Install a terraform, opentofu or terragrunt version'
exports.builder = (yargs) => {
  return yargs
    .positional('ver', { type: 'string', describe: 'Version, e.g. 1.10.2, 1.10.^ or latest' })
    .option('arch', {
      alias: 'a',
      describe: 'Specify system architecture (arm64, amd64, etc). Defaults to your system arch.',
      type: 'string',
      default: '',
    })
    .option('provider', {
      alias: 'p',
      describe: 'Provider to install: terraform (default), tofu/opentofu, or terragrunt/tg',
      type: 'string',
      default: 'terraform',
    })
    .epilog([
      'Version formats: latest, x.x.x (exact), x^ (latest major), x.x.^ (latest minor)',
      'Examples:',
      '  teriac install latest',
      '  teriac install 1.7.3',
      '  teriac install 1.7.^',
      '  teriac install latest --provider tofu',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const { ver, arch, provider } = argv;
  await install(ver, arch, provider);
}
