'use strict'

const {argv} = require('yargs');
const {install} = require('../modules/install');
const {fetchAllVersions} = require('../modules/available');

exports.command = 'install <version> [series]'
exports.aliases = ['i']
exports.desc = 'Usage: tfversion install <version>'
exports.builder = {
  'opt': {
    describe: 'Produce detailed output',
    // demand: true
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
