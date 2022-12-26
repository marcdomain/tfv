'use strict'

const yargs = require('yargs');
const {use} = require('../modules/use');

exports.command = 'use <version>'
exports.desc = 'Example: tfv use 1.0.11'
exports.builder = {
  verbose: {
    alias: 'v',
    describe: 'Produce detailed output',
    type: 'boolean',
  }
}

exports.handler = async () => {
  const [,version] = yargs.argv._;

  await use(version);
}
