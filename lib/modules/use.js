// const {spawnSync} = require('child_process');
const fs = require('fs')
const os = require('os');
const {join} = require('path');

exports.use = async (tfVer) => {
  try {
    let version = tfVer;

    if (version === 'latest') {
      [version] = fs.readdirSync(join(__dirname, '../../store')).sort((a, b) => {
        [aNum] = a.split('-');
        [bNum] = b.split('-');
        return bNum.localeCompare(aNum)
      });

      console.log(`Your latest installed version is ${version}`);
    }

    console.log(`Switching to terraform ${version}`);

    const getVersion = os.platform() === 'win32' ? `${version}.exe`: version;
    const source = join(__dirname, '../../store', getVersion);

    if (!fs.existsSync(source)) {
      console.log(`terraform ${version} is not installed`);
      return console.log(`To install this version Run: tfversion install ${version}`);
    }

    let destination;

    if (['darwin', 'linux'].includes(os.platform())) {
      const bin = os.platform() === 'darwin' ? '/usr/local/bin' : `${os.homedir()}/bin`;

      destination = `${bin}/terraform`;
    }

    if (os.platform() === 'win32') {
      fs.mkdirSync('C:\\terraform', { recursive: true });
      destination = 'C:\\terraform\\terraform.exe';
    }

    fs.copyFileSync(source, destination);

    console.log('Successful!')
  } catch ({message}) {
    console.log('ERROR:', message)
  }
}
