const fs = require('fs');
const {join} = require('path');
const {use} = require('./use');
const {install} = require('./install');
const {P_END, P_ERROR, P_INFO} = require('../utils/colors');
const {checkStore} = require('../utils/store');

exports.autoSwitch = async () => {
  try {
    let versionFile;
    let tfVersion;
    const tfState = `terraform.tfstate`;

    if (fs.existsSync(tfState)) {
      versionFile = tfState;
      tfVersion = JSON.parse(fs.readFileSync(tfState, 'utf-8'))['terraform_version'];
    } else {
      const getAllFiles = fs.readdirSync(process.cwd());
      const likelyVersionFiles = ['main.tf', 'provider.tf', 'providers.tf', 'versions.tf', 'version.tf', 'backend.tf', 'terraform.tf'];
      const existingFiles = getAllFiles.filter(f => likelyVersionFiles.indexOf(f) !== -1);
      const checkVersionIn = existingFiles.concat(getAllFiles.filter(f => existingFiles.indexOf(f) === -1)).filter(f => f.endsWith('.tf'));

      for (let i = 0; i < checkVersionIn.length; i++) {
        versionFile = checkVersionIn[i];
        const requiredVersion = fs.readFileSync(versionFile, 'utf-8');
        const pattern = /^([\s]{0,}required_version)[\s]{0,}=[\s]{0,}"(>=|=|>|~>)[\s]{0,}\d+.*"/m;
        const specified = requiredVersion.match(pattern);

        if (specified) {
          const vPattern = /\d+(\.\d+)?(\.\d+)?/;
          [tfVersion] = specified[0].trim().match(vPattern);
          break;
        }
      }
    }

    if (tfVersion) {
      console.log('required_version was found in:', versionFile);
      const store = join(__dirname, '../..', 'store');

      checkStore(store);

      const inStore = fs.readdirSync(store).find(v => v.startsWith(tfVersion));

      if (inStore) {
        await use(inStore);
      } else {
        const version = await install(`${tfVersion}^`);
        await use(version);
      }
    } else {
      console.log(`${P_ERROR}NOT FOUND:${P_END}${P_INFO}required_version${P_END}`);
      console.log(`${P_INFO}check in your remote state file${P_END}`);
    }

  } catch ({message}) {
    console.log('ERROR:', message)
  }
}

