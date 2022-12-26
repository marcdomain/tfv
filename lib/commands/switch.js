'use strict'

const {autoSwitch} = require('../modules/switch');

exports.command = 'auto-switch'
exports.aliases = ['as']
exports.desc = 'Example: tfv as'
exports.builder = {
  'verbose': {
    describe: 'Produce detailed output',
    alias: 'v',
    type: 'boolean'
  }
}

exports.handler = async () => {
  await autoSwitch();
}
