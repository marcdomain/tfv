'use strict'

const {argv} = require('yargs');
const {use} = require('../modules/use');

exports.command = 'use <version>'
exports.desc = 'Usage: tfv use <version>'
exports.builder = {
  'verbose': {
    alias: 'v',
    describe: 'Produce detailed output'
  }
}

exports.handler = async () => {
  const [,version] = argv._;

  await use(version);
}
