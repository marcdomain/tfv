'use strict'

const yargs = require('yargs');
const {remove} = require('../modules/remove');

exports.command = 'remove <version>'
exports.aliases = ['rm']
exports.desc = 'Remove a list of versions managed by tfv'
exports.builder = {
  verbose: {
    describe: 'Produce detailed output',
    type: 'boolean',
  }
}

exports.handler = async () => {
  const [,...version] = yargs.argv._;

  await remove(version);
}
