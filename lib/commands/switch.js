'use strict'

const {autoSwitch} = require('../modules/switch');

exports.command = 'auto-switch'
exports.aliases = ['as']
exports.desc = 'Auto-detect and switch to your project terraform version'
exports.builder = (yargs) => {
  return yargs
    .option('verbose', {
      describe: 'Produce detailed output',
      type: 'boolean'
    })
    .epilog('Reads version from .terraform-version or required_version in .tf files\nExample: tfv auto-switch')
}

exports.handler = async () => {
  await autoSwitch();
}
