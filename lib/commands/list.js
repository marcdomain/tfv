'use strict'

const {argv} = require('yargs');
const {list} = require('../modules/list');

exports.command = 'list [option]'
exports.aliases = ['ls']
exports.desc = 'Usage: tfv list [option]'
exports.builder = {
  local: {
    alias: 'l',
    describe: 'Get a list of Terraform versions you have installed using tfv',
    type: 'boolean'
  },
  remote: {
    alias: 'r',
    describe: 'Get a list of all available terraform versions',
    type: 'boolean',
  }
}

exports.handler = async () => {
  const {local, remote} = argv;
  await list(local, remote);
}
