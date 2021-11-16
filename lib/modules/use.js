const os = require('os');
const {join} = require('path');
const {spawnSync} = require('child_process');
const {readdirSync, mkdirSync, copyFileSync, existsSync} = require('fs');
const {setWindowsTerraform} = require('./ps1');
const {P_END, P_OK, P_INFO, P_ERROR} = require('../utils/colors');

exports.use = async (tfVer) => {
  try {
    let version = os.platform() === 'win32' ? `${tfVer}.exe` : tfVer;

    if (tfVer === 'latest') {
      [version] = readdirSync(join(__dirname, '../../store')).sort((a, b) => {
        const aVer = a.replace(/(.exe)|\./g, '')
        const bVer = b.replace(/(.exe)|\./g, '')
        return Number(bVer) - Number(aVer)
      });

      console.log(`${P_INFO}Your latest installed version is ${version}${P_END}`);
    }

    console.log(`${P_INFO}Switching to terraform ${version}${P_END}`);

    const source = join(__dirname, '../../store', version);

    if (!existsSync(source)) {
      console.log(`${P_ERROR}terraform ${version} is not installed${P_END}`);
      return console.log(`To install this version Run: ${P_OK}tfv install ${version}${P_END}`);
    }

    let destination;

    if (['darwin', 'linux'].includes(os.platform())) {
      const bin = os.platform() === 'darwin' ? '/usr/local/bin' : `${os.homedir()}/bin`;

      destination = `${bin}/terraform`;
      spawnSync('sudo', ['rm', `${destination}`], {stdio: 'inherit', shell: true});
      spawnSync('sudo', ['cp', `${source}`, `${destination}`], {stdio: 'inherit', shell: true});
    }

    if (os.platform() === 'win32') {
      mkdirSync('C:\\terraform', { recursive: true });
      destination = 'C:\\terraform\\terraform.exe';

      copyFileSync(source, destination);
      setWindowsTerraform();
    }

    console.log(`${P_OK}Successful!${P_END}`)
  } catch ({message}) {
    console.log('ERROR:', message)
  }
}
