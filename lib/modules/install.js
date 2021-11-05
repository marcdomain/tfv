const https = require('https');
const os = require('os');
const fs = require('fs');
const {join} = require('path');
const {arch} = process;
const unzip = require('decompress');

// console.log(os.platform(), process.platform, process.arch, process.release)
exports.install = async (version) => {
  try {
    const sysOs = os.platform() === 'win32' ? 'windows' : os.platform();
    let sysArch = arch;

    if (sysArch === 'x64') sysArch = 'amd64'
    if (sysArch === 'x32') sysArch = '386'

    const url = `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_${sysOs}_${sysArch}.zip`;
    console.log(`Installing terraform ${version}`);

    const req = https.get(url, (res) => {
      const fileStream = fs.createWriteStream(join(__dirname, `../../${version}.zip`));
      res.pipe(fileStream);

      fileStream.on('error', (err) => {
        console.log('Error writing stream \n', err);
      });

      fileStream.on('close', () => clean(version));

      fileStream.on('finish', () => {
        fileStream.close();
        console.log('Successful!');
        console.log(`To use this version Run: tfversion use ${version}`);
      })
    });

    req.on('error', (err) => {
      console.log(`Error downloading the terraform ${version} \n`, err)
    });

    const clean = async (version) => {
      const fileName = join(__dirname, '../..', `${version}.zip`);
      const store = join(__dirname, '../..', 'store');

      if (fs.existsSync(fileName)) {
        await unzip(fileName, store, {
          map: file => {
            const [, ext] = `${file.path}`.split('.');
            file.path = ext ? `${version}.${ext}` : `${version}`;
            return file;
          }
        });

        fs.unlinkSync(fileName)
      }
    }
  } catch ({message}) {
    console.log('ERROR:', message)
  }
}
