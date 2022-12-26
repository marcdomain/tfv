'use strict'

const yargs = require('yargs');
const {install} = require('../modules/install');

exports.command = 'install <version>'
exports.aliases = ['i']
exports.desc = 'Example: tfv install 1.0.11'
exports.builder = {
  'verbose': {
    describe: 'Produce detailed output',
    alias: 'v',
    type: 'boolean',
  }
}

exports.handler = async () => {
  const [,version] = yargs.argv._;

  await install(version);
}
