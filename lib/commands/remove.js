'use strict'

const yargs = require('yargs');
const {remove} = require('../modules/remove');

exports.command = 'remove <version>'
exports.aliases = ['rm']
exports.desc = 'Example: tfv rm 1.0.11'
exports.builder = {
  'verbose': {
    describe: 'Produce detailed output',
    alias: 'v',
    type: 'boolean',
  }
}

exports.handler = async () => {
  const [,version] = yargs.argv._;

  await remove(version);
}
