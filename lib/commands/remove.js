'use strict'

const yargs = require('yargs');
const {remove} = require('../modules/remove');

exports.command = 'remove <version>'
exports.aliases = ['rm']
exports.desc = 'Remove terraform versions from tfv store'
exports.builder = (yargs) => {
  return yargs
    .option('verbose', {
      describe: 'Produce detailed output',
      type: 'boolean',
    })
    .epilog('Example: tfv rm 1.5.7 1.4.6')
}

exports.handler = async () => {
  const [,...version] = yargs.argv._;

  await remove(version);
}
