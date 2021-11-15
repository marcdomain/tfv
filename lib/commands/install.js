'use strict'

const {argv} = require('yargs');
const {install} = require('../modules/install');
const {fetchAllVersions} = require('../modules/remote');

exports.command = 'install <version>'
exports.aliases = ['i']
exports.desc = 'Usage: tfv install <version>'
exports.builder = {
  'verbose': {
    describe: 'Produce detailed output',
    alias: 'v'
  }
}

exports.handler = async () => {
  let [,version] = argv._;
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
    console.log(`Terraform ${version} not found. To view a list of available version, use "tfv list --remote"`);
    process.exit(1);
  }

  await install(version);
}
