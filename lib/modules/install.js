const https = require('https');
const os = require('os');
const {
  chmodSync,
  existsSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  createWriteStream
} = require('fs');
const {join} = require('path');
const {arch} = process;
const unzip = require('decompress');
const {fetchAllVersions} = require('./remote');
const {formatVersions} = require('../utils/formatVersions');
const {P_END, P_ERROR, P_INFO, P_OK, P_WARN} = require('../utils/colors');

exports.install = async (installVersion, sysArchitecture) => {
  try {
    let version = installVersion;
    const store = join(__dirname, '../..', 'store');
    const data = await fetchAllVersions();
    const result = formatVersions(data);

    if (version === 'latest') {
      [version] = result.filter(v => {
        const [, inTest] = v.split('-');
        if (!inTest) return v;
      });
    }

    if (`${version}`.endsWith('^')) {
      [version] = result.filter(v => {
        const [, inTest] = v.split('-');
        if (v.startsWith(version.replace('^', '')) && !inTest) return v
      });
      version = version ? version : installVersion.replace('^', '');
    }

    if (!result.find(v => v === version)) {
      console.log(`${P_ERROR}Terraform ${version} not found.${P_END}`);
      console.log(`To view a list of available version, run ${P_OK}tfv list --remote${P_END}`);
      process.exit(1);
    }

    const getVersion = os.platform() === 'win32' ? `${version}.exe` : version;

    if (existsSync(`${store}/${getVersion}`)) {
      console.log(`${P_WARN}Terraform ${version} is already installed${P_END}`);
      return console.log(`To use this version Run: ${P_OK}tfv use ${version}${P_END}`)
    }

    const sysOs = os.platform() === 'win32' ? 'windows' : os.platform();
    let sysArch = arch === 'x64' ? 'amd64' : arch;

    if (os.platform() === 'darwin' && version.startsWith('0')) {
      sysArch = 'amd64'
    }

    const archOption = sysArchitecture || sysArch;

    const url = `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_${sysOs}_${archOption}.zip`;

    const manageTfArch = async (version) => {
      const archMap = `${store}/arch.json`;
      const archStore = readFileSync(`${archMap}`, 'utf8');
      const parseArchFile = JSON.parse(archStore);
      parseArchFile[version] = archOption;
      writeFileSync(`${archMap}`, JSON.stringify(parseArchFile, null, 2));
    }

    const fileName = join(__dirname, '../..', `${version}.zip`);

    const unzipFile = async (version) => {
      if (existsSync(fileName)) {
        await unzip(fileName, store, {
          map: file => {
            const [, ext] = `${file.path}`.split('.');
            file.path = ext ? `${version}.${ext}` : `${version}`;
            return file;
          }
        });

        unlinkSync(fileName);
      }
    }

    const makeExecutable = async (version) => {
      if (sysOs !== 'windows') {
        chmodSync(`${store}/${version}`, '755');
      }
    }

    return new Promise((resolve, reject) => {
      const req = https.get(url, (res) => {
        console.log(`${P_INFO}Installing terraform ${version} (for ${archOption} architecture) ${P_END}`);

        const fileStream = createWriteStream(fileName);
        res.pipe(fileStream);

        fileStream.on('error', (err) => {
          console.log(`${P_ERROR}Error writing stream ${P_END}\n`, err);
        });

        fileStream.on('close', async () => {
          await unzipFile(version);
          await manageTfArch(version);
          await makeExecutable(version);
          resolve(version);
        });

        fileStream.on('finish', () => {
          fileStream.close();
          console.log(`${P_OK}Successful!${P_END}`);
          console.log(`To use this version Run: ${P_OK}tfv use ${version}${P_END}`);
        })
      });

      req.on('error', (err) => {
        reject(console.log(`${P_ERROR}Error downloading the terraform ${version}${P_END}\n`, err))
      });
    });

  } catch ({message}) {
    console.log('ERROR:', message)
  }
}
