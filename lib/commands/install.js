'use strict'

const {argv} = require('yargs');
const {install} = require('../modules/install');
const {fetchAllVersions} = require('../modules/remote');

exports.command = 'install <version> [series]'
exports.aliases = ['i']
exports.desc = 'Usage: tfv install <version>'
exports.builder = {
  'verbose': {
    describe: 'Produce detailed output',
    alias: 'v'
  }
}

exports.handler = async () => {
  const [,version, series] = argv._;
  let tfVersion = version;

  if (tfVersion === 'latest') {
    const result = await fetchAllVersions();
    [tfVersion] = result.filter(v => {
      const [, inTest] = v.split('-');
      if (!inTest) return v;
    });

    if (series) {
      [tfVersion] = result.filter(v => {
        const [, inTest] = v.split('-');
        if (v.startsWith(series.replace('^', '')) && !inTest) return v
      });
    }
  }

  await install(tfVersion);
}
