const https = require('https');
const os = require('os');
const fs = require('fs');
const {join} = require('path');
const {arch} = process;
const unzip = require('decompress');
const {P_END, P_ERROR, P_INFO, P_OK, P_WARN} = require('../utils/colors');

exports.install = async (version) => {
  try {
    const store = join(__dirname, '../..', 'store');
    const fileName = join(__dirname, '../..', `${version}.zip`);
    const getVersion = os.platform() === 'win32' ? `${version}.exe` : version;

    if (fs.existsSync(`${store}/${getVersion}`)) {
      console.log(`${P_WARN}Terraform ${version} is already installed${P_END}`);
      return console.log(`To use this version Run: ${P_OK}tfv use ${version}${P_END}`)
    }

    const sysOs = os.platform() === 'win32' ? 'windows' : os.platform();
    let sysArch = arch === 'x64' ? 'amd64' : arch;

    const url = `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_${sysOs}_${sysArch}.zip`;

    const req = https.get(url, (res) => {
      console.log(`${P_INFO}Installing terraform ${version}${P_END}`);

      const fileStream = fs.createWriteStream(fileName);
      res.pipe(fileStream);

      fileStream.on('error', (err) => {
        console.log(`${P_ERROR}Error writing stream ${P_END}\n`, err);
      });

      fileStream.on('close', async () => {
        await clean(version);
        makeExecutable(version);
      });

      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`${P_OK}Successful!${P_END}`);
        console.log(`To use this version Run: ${P_OK}tfv use ${version}${P_END}`);
      })
    });

    req.on('error', (err) => {
      console.log(`${P_ERROR}Error downloading the terraform ${version}${P_END}\n`, err)
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
