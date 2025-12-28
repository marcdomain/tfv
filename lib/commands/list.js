'use strict'

const yargs = require('yargs');
const {list} = require('../modules/list');

exports.command = 'list [option]'
exports.aliases = ['ls']
exports.desc = 'List installed or available terraform versions'
exports.builder = (yargs) => {
  return yargs
    .option('local', {
      alias: 'l',
      describe: 'List terraform versions you have installed using tfv',
      type: 'boolean',
      default: true,
    })
    .option('remote', {
      alias: 'r',
      describe: 'List all available terraform versions',
      type: 'boolean',
    })
    .epilog('Examples:\n  tfv ls            List locally installed versions\n  tfv ls --remote   List all available remote versions')
}

exports.handler = async () => {
  const {local, remote} = yargs.argv;
  await list(local, remote);
}

