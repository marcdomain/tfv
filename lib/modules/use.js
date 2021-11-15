const fs = require('fs')
const os = require('os');
const {join} = require('path');
const {setWindowsTerraform} = require('./ps1');

exports.use = async (tfVer) => {
  try {
    let version = tfVer;

    if (version === 'latest') {
      [version] = fs.readdirSync(join(__dirname, '../../store')).sort((a, b) => {
        const aVer = a.replace(/(.exe)|\./g, '')
        const bVer = b.replace(/(.exe)|\./g, '')
        return Number(bVer) - Number(aVer)
      });

      console.log(`Your latest installed version is ${version}`);
    }

    console.log(`Switching to terraform ${version}`);

    const source = join(__dirname, '../../store', version);

    if (!fs.existsSync(source)) {
      console.log(`terraform ${version} is not installed`);
      return console.log(`To install this version Run: tfv install ${version}`);
    }

    let destination;

    if (['darwin', 'linux'].includes(os.platform())) {
      const bin = os.platform() === 'darwin' ? '/usr/local/bin' : `${os.homedir()}/bin`;

      destination = `${bin}/terraform`;
    }

    if (os.platform() === 'win32') {
      fs.mkdirSync('C:\\terraform', { recursive: true });
      destination = 'C:\\terraform\\terraform.exe';

      setWindowsTerraform();
    }

    fs.copyFileSync(source, destination);

    console.log('Successful!')
  } catch ({message}) {
    console.log('ERROR:', message)
  }
}
