const fs = require('fs');
const {join} = require('path');
const {spawnSync} = require('child_process')
const {fetchAllVersions} = require('./remote');
const {formatVersions} = require('../utils/formatVersions');
const {P_END, P_OK} = require('../utils/colors');
const {checkStore} = require('../utils/store');

exports.list = async (local, remote) => {
  try {
    let versions;

    const result = (message, v) => {
      console.log(`${P_OK}${message}${P_END}` + '\n');
      console.log(v.join('\n'));
    }

    if (remote) {
      const data = await fetchAllVersions();
      versions = formatVersions(data);

      return result('List of all available terraform versions', versions)
    }

    if (local) {
      const store = join(__dirname, '../..', 'store');

      checkStore(store);

      const tfVersion = spawnSync('terraform', ['version'], {stdio: 'pipe', encoding: 'utf-8'});
      const pattern = /v\d+\.\d+\.\d+/;
      const versionOutput = tfVersion.stdout.match(pattern);

      versions = fs.readdirSync(store).map(f => {
        const versionNumber = f.replace('.exe', '');

        if (versionOutput && versionNumber === versionOutput[0].replace('v', '')) return `${versionNumber} 🚀`;
        else return versionNumber;
      });

      return result('Terraform versions installed by tfv', versions);
    }
  } catch ({message}) {
    console.log(message)
  }
}
