'use strict'

const yargs = require('yargs');
const {existsSync} = require('fs');
const {join} = require('path');
const {use} = require('../modules/use');
const {P_ERROR, P_END, P_OK} = require('../utils/colors');

exports.command = 'use <version>'
exports.desc = 'Example: tfv use 1.0.11'
exports.builder = {
  verbose: {
    alias: 'v',
    describe: 'Produce detailed output'
  }
}

exports.handler = async () => {
  const [,version] = yargs.argv._;

  if (!existsSync(join(__dirname, '../../', 'store'))) {
    console.log(`${P_ERROR}You're yet to install terraform with tfv${P_END}`);
    return console.log(`For guidance, run ${P_OK}tfv -h${P_END}`);
  }

  await use(version);
}
