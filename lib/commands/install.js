'use strict'

const yargs = require('yargs');
const {install} = require('../modules/install');

exports.command = 'install <version>'
exports.aliases = ['i']
exports.desc = 'Install a terraform version'
exports.builder = {
  arch: {
    describe: 'Specify system architecture',
    alias: 'a',
    type: 'string',
    default: ''
  }
}

exports.handler = async () => {
  const [,version] = yargs.argv._;
  const {arch} = yargs.argv;

  await install(version, arch);
}
