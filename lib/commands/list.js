'use strict'

const yargs = require('yargs');
const {list} = require('../modules/list');

exports.command = 'list [option]'
exports.aliases = ['ls']
exports.desc = 'Example: tfv list --local'
exports.builder = {
  local: {
    alias: 'l',
    describe: 'List terraform versions you have installed using tfv',
    type: 'boolean',
    default: true,
  },
  remote: {
    alias: 'r',
    describe: 'List all available terraform versions',
    type: 'boolean',
  }
}

exports.handler = async () => {
  const {local, remote} = yargs.argv;
  await list(local, remote);
}
