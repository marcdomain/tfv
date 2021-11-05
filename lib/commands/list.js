'use strict'

const {argv} = require('yargs');
const {list} = require('../modules/list');

exports.command = 'list [option]'
exports.aliases = ['ls']
exports.desc = 'Usage: tfversion list [option]'
exports.builder = {
  installed: {
    alias: 'i',
    describe: 'Get a list of Terraform versions installed by tfversion',
    type: 'boolean'
  },
  all: {
    alias: 'a',
    describe: 'Get a list of all available terraform versions',
    type: 'boolean',
  }
}

exports.handler = async () => {
  const {i, a} = argv;
  await list(i, a);
}
