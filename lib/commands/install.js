'use strict'

const yargs = require('yargs');
const {install} = require('../modules/install');

exports.command = 'install <version> [option]'
exports.aliases = ['i']
exports.desc = 'Install a terraform version'
exports.builder = (yargs) => {
  return yargs
    .option('arch', {
      alias: 'a',
      describe: 'Specify system architecture. Defaults is the user system architecture',
      type: 'string',
      default: ''
    })
    .epilog('Version formats: latest, x.x.x (exact), x^ (latest major), x.x.^ (latest minor)\nExample: tfv install 1.5.7 --arch amd64')
}

exports.handler = async () => {
  const [,version] = yargs.argv._;
  const {arch} = yargs.argv;

  await install(version, arch);
}

