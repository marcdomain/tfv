'use strict'

const yargs = require('yargs');
const {remove} = require('../modules/remove');

exports.command = 'remove <version>'
exports.aliases = ['rm']
exports.desc = 'Example: tfv rm <version>'
exports.builder = {
  'verbose': {
    describe: 'Produce detailed output',
    alias: 'v'
  }
}

exports.handler = async () => {
  let [,version] = yargs.argv._;

  await remove(version);
}
