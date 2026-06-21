'use strict'

const { doctor } = require('../modules/doctor');

exports.command = 'doctor'
exports.desc = 'Run diagnostics: PATH, binaries, store, shell config'
exports.builder = (yargs) => {
  return yargs
    .epilog([
      'Checks PATH order, active binaries, store directories,',
      'shell config, and PATH conflicts.',
      '',
      'Example:',
      '  tfv doctor',
    ].join('\n'))
}

exports.handler = async () => {
  await doctor();
}
