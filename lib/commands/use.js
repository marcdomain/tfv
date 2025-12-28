'use strict'

const yargs = require('yargs');
const {use} = require('../modules/use');

exports.command = 'use <version>'
exports.desc = 'Switch to a specified terraform version\n'
exports.builder = (yargs) => {
  return yargs
    .option('verbose', {
      describe: 'Produce detailed output',
      type: 'boolean',
    })
    .epilog('Example: tfv use 1.5.7')
}

exports.handler = async () => {
  const [,version] = yargs.argv._;

  await use(version);
}

