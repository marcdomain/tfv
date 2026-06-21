'use strict'

const { prune } = require('../modules/prune');

exports.command = 'prune'
exports.desc = 'Remove all non-active installed versions to free disk space'
exports.builder = (yargs) => {
  return yargs
    .option('keep', {
      alias: 'k',
      describe: 'Keep the N most recent versions in addition to the active one',
      type: 'number',
      default: 0,
    })
    .option('provider', {
      alias: 'p',
      describe: 'Provider: terraform (default) or tofu/opentofu',
      type: 'string',
      default: 'terraform',
    })
    .option('yes', {
      alias: 'y',
      describe: 'Skip confirmation prompt',
      type: 'boolean',
      default: false,
    })
    .epilog([
      'Always keeps the currently active version.',
      '',
      'Examples:',
      '  tfv prune                   # remove all but active',
      '  tfv prune --keep 2          # remove all but active + 2 most recent',
      '  tfv prune --provider tofu',
      '  tfv prune --yes             # skip confirmation',
    ].join('\n'))
}

exports.handler = async (argv) => {
  const { provider, keep, yes } = argv;
  await prune(provider, keep, yes);
}
