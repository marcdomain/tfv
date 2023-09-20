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

      const archMap = `${store}/arch.json`;
      const archStore = fs.readFileSync(`${archMap}`, 'utf8');
      const parseArchFile = JSON.parse(archStore);
      const installedVersions = [];

      versions = fs.readdirSync(store).forEach(f => {
        if (f !== 'arch.json') {
          const versionNumber = f.replace('.exe', '');
          const vnObj = {};

          vnObj['Terraform Version'] = versionNumber;

          if (versionOutput && versionNumber === versionOutput[0].replace('v', '')) {
            vnObj['System Arch'] = `${parseArchFile[versionNumber]} 🚀`;
          }
          else vnObj['System Arch'] = parseArchFile[versionNumber];
          installedVersions.push(vnObj);
        }
      });

      console.log(`${P_OK}Terraform versions installed by tfv${P_END}`);
      return console.table(installedVersions);
    }
  } catch ({message}) {
    console.log(message)
  }
}
