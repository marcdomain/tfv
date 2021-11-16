'use strict'

const yargs = require('yargs');
const {install} = require('../modules/install');
const {fetchAllVersions} = require('../modules/remote');
const {P_END, P_ERROR, P_OK} = require('../utils/colors');

exports.command = 'install <version>'
exports.aliases = ['i']
exports.desc = 'Example: tfv install 1.0.11'
exports.builder = {
  'verbose': {
    describe: 'Produce detailed output',
    alias: 'v'
  }
}

exports.handler = async () => {
  let [,version] = yargs.argv._;
  const result = await fetchAllVersions();

  if (version === 'latest') {
    [version] = result.filter(v => {
      const [, inTest] = v.split('-');
      if (!inTest) return v;
    });
  }

  if (`${version}`.endsWith('^')) {
    [version] = result.filter(v => {
      const [, inTest] = v.split('-');
      if (v.startsWith(version.replace('^', '')) && !inTest) return v
    });
  }

  if (!result.find(v => v === version)) {
    console.log(`${P_ERROR}Terraform ${version} not found.${P_END}`);
    console.log(`To view a list of available version, run ${P_OK}tfv list --remote${P_END}`);
    process.exit(1);
  }

  await install(version);
}
