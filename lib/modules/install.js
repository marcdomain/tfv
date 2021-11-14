const https = require('https');
const os = require('os');
const fs = require('fs');
const {join} = require('path');
const {arch} = process;
const unzip = require('decompress');

exports.install = async (version) => {
  try {
    const sysOs = os.platform() === 'win32' ? 'windows' : os.platform();
    let sysArch = arch === 'x64' ? 'amd64' : '386';

    const url = `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_${sysOs}_${sysArch}.zip`;

    const store = join(__dirname, '../..', 'store');
    const fileName = join(__dirname, '../..', `${version}.zip`);

    const req = https.get(url, (res) => {
      console.log(`Installing terraform ${version}`);

      const fileStream = fs.createWriteStream(fileName);
      res.pipe(fileStream);

      fileStream.on('error', (err) => {
        console.log('Error writing stream \n', err);
      });

      fileStream.on('close', () => {
        clean(version);
        makeExecutable(version);
      });

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
      if (fs.existsSync(fileName)) {
        await unzip(fileName, store, {
          map: file => {
            const [, ext] = `${file.path}`.split('.');
            file.path = ext ? `${version}.${ext}` : `${version}`;
            return file;
          }
        });

        fs.unlinkSync(fileName);
      }
    }

    const makeExecutable = async (version) => {
      if (sysOs !== 'windows') {
        fs.chmodSync(`${store}/${version}`, '755');
      }
    }
  } catch ({message}) {
    console.log('ERROR:', message)
  }
}
