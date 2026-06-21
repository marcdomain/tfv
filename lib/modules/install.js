const https = require('https');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { join } = path;
const {
  chmodSync, existsSync, unlinkSync,
  readFileSync, writeFileSync, createWriteStream
} = require('fs');
const AdmZip = require('adm-zip');
const { fetchAllVersions, fetchUrl } = require('./remote');
const { normalizeProvider, getProviderStore, getVersionFile, initDirs } = require('../utils/paths');
const { P_END, P_ERROR, P_INFO, P_OK, P_WARN } = require('../utils/colors');

const getDownloadUrl = (provider, version, sysOs, archOption) => {
  if (provider === 'opentofu') {
    const osName = sysOs === 'darwin' ? 'darwin' : sysOs === 'win32' ? 'windows' : 'linux';
    return `https://github.com/opentofu/opentofu/releases/download/v${version}/tofu_${version}_${osName}_${archOption}.zip`;
  }
  const osName = sysOs === 'win32' ? 'windows' : sysOs;
  return `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_${osName}_${archOption}.zip`;
};

const getSha256Url = (provider, version, sysOs, archOption) => {
  if (provider === 'opentofu') {
    return `https://github.com/opentofu/opentofu/releases/download/v${version}/tofu_${version}_SHA256SUMS`;
  }
  return `https://releases.hashicorp.com/terraform/${version}/terraform_${version}_SHA256SUMS`;
};

const getZipName = (provider, version, sysOs, archOption) => {
  const osName = sysOs === 'win32' ? 'windows' : sysOs === 'darwin' ? 'darwin' : 'linux';
  const prefix = provider === 'opentofu' ? 'tofu' : 'terraform';
  return `${prefix}_${version}_${osName}_${archOption}.zip`;
};

const verifyChecksum = async (filePath, provider, version, sysOs, archOption) => {
  const sumsUrl = getSha256Url(provider, version, sysOs, archOption);
  const zipName = getZipName(provider, version, sysOs, archOption);

  const sumsData = await fetchUrl(sumsUrl);
  const matchLine = sumsData.split('\n').find(l => l.includes(zipName));

  if (!matchLine) throw new Error(`Checksum entry not found for ${zipName}`);

  const [expectedHash] = matchLine.trim().split(/\s+/);
  const fileBuffer = readFileSync(filePath);
  const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  if (actualHash !== expectedHash) {
    throw new Error(`SHA256 mismatch!\n  Expected: ${expectedHash}\n  Got:      ${actualHash}`);
  }
};

const showProgress = (received, total) => {
  if (!total) return;
  const pct = Math.min(100, Math.floor((received / total) * 100));
  const filled = Math.floor(pct / 2);
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(50 - filled);
  process.stdout.write(`\r  [${bar}] ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
};

const providerFlag = (providerArg) => providerArg === 'terraform' ? '' : ` --provider ${providerArg}`;

exports.install = async (installVersion, sysArchitecture, providerArg = 'terraform') => {
  try {
    initDirs();

    const provider = normalizeProvider(providerArg);
    let version = installVersion;

    // isExplicitPreRelease: user typed e.g. "1.8.0-beta1" intentionally.
    // In that case we skip stable-only validation and let the download confirm existence.
    const isExplicitPreRelease = version !== 'latest'
      && !`${version}`.endsWith('^')
      && `${version}`.includes('-');

    // Stable versions only — used for latest/^ resolution and validation of stable requests.
    const stableVersions = isExplicitPreRelease ? [] : await fetchAllVersions(provider);

    if (version === 'latest') {
      version = stableVersions[0];
    }

    if (`${version}`.endsWith('^')) {
      const prefix = version.replace('^', '');
      version = stableVersions.find(v => v.startsWith(prefix)) || prefix;
    }

    // Validate explicit stable version exists; skip check for explicit pre-releases.
    if (!isExplicitPreRelease && !stableVersions.includes(version)) {
      console.log(`${P_ERROR}${provider} ${version} not found.${P_END}`);
      console.log(`To view available versions, run ${P_OK}tfv list --remote${providerFlag(providerArg)}${P_END}`);
      process.exit(1);
    }

    if (isExplicitPreRelease) {
      console.log(`${P_WARN}Installing pre-release version ${version}. Use stable versions for production.${P_END}`);
    }

    const store = getProviderStore(provider);
    const storedFile = getVersionFile(provider, version);

    if (existsSync(storedFile)) {
      console.log(`${P_WARN}${provider} ${version} is already installed${P_END}`);
      return console.log(`To use this version run: ${P_OK}tfv use ${version}${providerFlag(providerArg)}${P_END}`);
    }

    const sysOs = os.platform();
    let sysArch = process.arch === 'x64' ? 'amd64' : process.arch;

    // Older terraform versions on macOS only had amd64 builds
    if (provider === 'terraform' && sysOs === 'darwin' && version.startsWith('0')) {
      sysArch = 'amd64';
    }

    const archOption = sysArchitecture || sysArch;
    const url = getDownloadUrl(provider, version, sysOs, archOption);
    const tmpZip = join(os.tmpdir(), `tfv-${provider}-${version}.zip`);

    await new Promise((resolve, reject) => {
      console.log(`${P_INFO}Downloading ${provider} ${version} (${archOption})...${P_END}`);

      // Defined before use to avoid temporal dead zone
      const handleResponse = (res) => {
        const total = parseInt(res.headers['content-length'], 10);
        let received = 0;

        const fileStream = createWriteStream(tmpZip);
        res.on('data', chunk => {
          received += chunk.length;
          showProgress(received, total);
        });
        res.pipe(fileStream);

        fileStream.on('error', reject);
        fileStream.on('finish', () => {
          fileStream.close();
          process.stdout.write('\n');
          resolve();
        });
      };

      const req = https.get(url, { headers: { 'User-Agent': 'tfv-cli' } }, (res) => {
        // Follow redirect — GitHub releases redirect to S3/CDN
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return https.get(res.headers.location, { headers: { 'User-Agent': 'tfv-cli' } }, handleResponse)
            .on('error', reject);
        }
        handleResponse(res);
      });

      req.on('error', reject);
    });

    console.log(`${P_INFO}Verifying SHA256 checksum...${P_END}`);
    await verifyChecksum(tmpZip, provider, version, sysOs, archOption);
    console.log(`${P_OK}Checksum verified.${P_END}`);

    console.log(`${P_INFO}Extracting...${P_END}`);
    const zip = new AdmZip(tmpZip);
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const ext = path.extname(entry.entryName).toLowerCase(); // '' or '.exe'
      if (!ext || ext === '.exe') {
        // Rename binary to the version number, preserving .exe on Windows
        const destName = ext ? `${version}${ext}` : version;
        writeFileSync(path.join(store, destName), entry.getData());
      }
      // All other entries (LICENSE.txt, CHANGELOG.md, etc.) are simply skipped
    }

    unlinkSync(tmpZip);

    if (sysOs !== 'win32') {
      chmodSync(storedFile, '755');
    }

    // Save arch mapping
    const archFile = join(store, 'arch.json');
    const archMap = JSON.parse(readFileSync(archFile, 'utf-8'));
    archMap[version] = archOption;
    writeFileSync(archFile, JSON.stringify(archMap, null, 2));

    console.log(`${P_OK}Installed ${provider} ${version} successfully!${P_END}`);
    console.log(`To use this version run: ${P_OK}tfv use ${version}${providerFlag(providerArg)}${P_END}`);
    return version;

  } catch (err) {
    console.log(`${P_ERROR}Install failed: ${err.message}${P_END}`);
    process.exit(1);
  }
};
