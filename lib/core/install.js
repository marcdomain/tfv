// Downloads, verifies and stores a terraform / opentofu / terragrunt version.
// Library code: never prints and never exits. Progress goes through `log`
// and `onProgress`; failures throw TfvError.
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const {
  chmodSync, copyFileSync, existsSync, unlinkSync, renameSync,
  readFileSync, writeFileSync, createWriteStream,
} = require('fs');
const AdmZip = require('adm-zip');
const { applyMirror, clientFor } = require('../utils/mirror');
const { fetchAllVersions, fetchUrl } = require('../modules/remote');
const { normalizeProvider, getProviderStore, getVersionFile, initDirs } = require('../utils/paths');
const { TfvError, CODES } = require('./errors');

const noop = () => {};

// Release OS name. Android (Termux) runs the linux builds.
const releaseOs = (sysOs) => sysOs === 'win32' ? 'windows' : sysOs === 'darwin' ? 'darwin' : 'linux';

// Terragrunt ships a raw binary; terraform and opentofu ship a zip.
const isRawBinary = (provider) => provider === 'terragrunt';

// File name of the release asset, as listed in the SHA256SUMS file.
const getAssetName = (provider, version, sysOs, archOption) => {
  const osName = releaseOs(sysOs);
  if (provider === 'terragrunt') {
    return `terragrunt_${osName}_${archOption}${osName === 'windows' ? '.exe' : ''}`;
  }
  const prefix = provider === 'opentofu' ? 'tofu' : 'terraform';
  return `${prefix}_${version}_${osName}_${archOption}.zip`;
};

const releaseBase = (provider, version) => ({
  terraform: `https://releases.hashicorp.com/terraform/${version}`,
  opentofu: `https://github.com/opentofu/opentofu/releases/download/v${version}`,
  terragrunt: `https://github.com/gruntwork-io/terragrunt/releases/download/v${version}`,
})[provider];

const getDownloadUrl = (provider, version, sysOs, archOption) =>
  applyMirror(`${releaseBase(provider, version)}/${getAssetName(provider, version, sysOs, archOption)}`);

const getSha256Url = (provider, version) => {
  const file = {
    terraform: `terraform_${version}_SHA256SUMS`,
    opentofu: `tofu_${version}_SHA256SUMS`,
    terragrunt: 'SHA256SUMS',
  }[provider];
  return applyMirror(`${releaseBase(provider, version)}/${file}`);
};

const verifyChecksum = async (filePath, provider, version, sysOs, archOption) => {
  const sumsData = await fetchUrl(getSha256Url(provider, version));
  const assetName = getAssetName(provider, version, sysOs, archOption);
  // Match the file name exactly: terragrunt also lists foo.zip and foo.tar.gz.
  const entry = sumsData.split('\n')
    .map(l => l.trim().split(/\s+/))
    .find(([, name]) => name && name.replace(/^\*/, '') === assetName);

  if (!entry) throw new TfvError(CODES.CHECKSUM_FAILED, `Checksum entry not found for ${assetName}`);

  const [expectedHash] = entry;
  const actualHash = crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex');
  if (actualHash !== expectedHash) {
    throw new TfvError(CODES.CHECKSUM_FAILED,
      `SHA256 mismatch!\n  Expected: ${expectedHash}\n  Got:      ${actualHash}`);
  }
};

// Streams `url` to `dest`, following one redirect (GitHub releases go to a CDN).
const download = (url, dest, failMessage, onProgress) => new Promise((resolve, reject) => {
  const fail = (err) => reject(err instanceof TfvError ? err : new TfvError(CODES.DOWNLOAD_FAILED, err.message));
  const headers = { 'User-Agent': 'tfv-cli' };

  const handleResponse = (res) => {
    if (res.statusCode >= 400) {
      res.resume();
      return fail(new TfvError(CODES.DOWNLOAD_FAILED, `${failMessage} (HTTP ${res.statusCode})`));
    }
    const total = parseInt(res.headers['content-length'], 10);
    let received = 0;
    const fileStream = createWriteStream(dest);
    res.on('data', chunk => {
      received += chunk.length;
      onProgress(received, total);
    });
    res.pipe(fileStream);
    fileStream.on('error', fail);
    fileStream.on('finish', () => {
      fileStream.close();
      resolve();
    });
  };

  clientFor(url).get(url, { headers }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      const next = new URL(res.headers.location, url).href;
      return clientFor(next).get(next, { headers }, handleResponse).on('error', fail);
    }
    handleResponse(res);
  }).on('error', fail);
});

/**
 * Picks the exact version to install. `requested` is an exact version,
 * a pre-release ("1.8.0-beta1"), "latest", or a prefix ending in "^" ("1.9^").
 */
const pickVersion = async (provider, requested, log) => {
  let version = `${requested}`;
  const isPreRelease = version !== 'latest' && !version.endsWith('^') && version.includes('-');
  if (isPreRelease) {
    log('warn', `Installing pre-release version ${version}. Use stable versions for production.`);
    return version;
  }

  // If the list can't be fetched (offline, mirror without an API) an exact
  // version still installs; the download itself confirms it exists.
  const isExact = /^\d+\.\d+\.\d+$/.test(version);
  let stable;
  try {
    stable = await fetchAllVersions(provider);
  } catch (err) {
    if (!isExact) {
      throw new TfvError(CODES.VERSION_LIST_UNAVAILABLE,
        `could not fetch the ${provider} version list (${err.message})`);
    }
    log('warn', `Could not fetch the ${provider} version list; trying ${version} directly.`);
    return version;
  }

  if (version === 'latest') version = stable[0];
  if (version.endsWith('^')) {
    const prefix = version.replace('^', '');
    version = stable.find(v => v.startsWith(prefix)) || prefix;
  }
  if (!stable.includes(version)) {
    throw new TfvError(CODES.VERSION_NOT_FOUND, `${provider} ${version} not found.`, { provider, version });
  }
  return version;
};

// Several jobs (tfv-server) may ask for the same version at once:
// share one download per provider@version within this process.
const inflight = new Map();

/**
 * Installs a version into the tfv store.
 * Options: arch (e.g. "arm64"), log(level, message), onProgress(received, total),
 * onDownloadEnd().
 * Returns { provider, version, binary, alreadyInstalled }.
 */
const installVersion = async (providerArg, requested, options = {}) => {
  const { arch, log = noop, onProgress = noop, onDownloadEnd = noop } = options;
  initDirs();
  const provider = normalizeProvider(providerArg);
  const version = await pickVersion(provider, requested, log);
  const binary = getVersionFile(provider, version);

  if (existsSync(binary)) return { provider, version, binary, alreadyInstalled: true };

  const key = `${provider}@${version}`;
  if (!inflight.has(key)) {
    const job = fetchAndStore(provider, version, binary, { arch, log, onProgress, onDownloadEnd })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  await inflight.get(key);
  return { provider, version, binary, alreadyInstalled: false };
};

const fetchAndStore = async (provider, version, binary, { arch, log, onProgress, onDownloadEnd }) => {
  const sysOs = os.platform();
  let sysArch = process.arch === 'x64' ? 'amd64' : process.arch;
  // Older terraform versions on macOS only had amd64 builds
  if (provider === 'terraform' && sysOs === 'darwin' && version.startsWith('0')) sysArch = 'amd64';
  const archOption = arch || sysArch;

  const unique = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const tmpDownload = path.join(os.tmpdir(), `tfv-${provider}-${version}-${unique}.download`);
  // Written next to the final file, then renamed, so readers never see half a binary.
  const tmpBinary = `${binary}.${unique}.tmp`;

  try {
    log('info', `Downloading ${provider} ${version} (${archOption})...`);
    await download(
      getDownloadUrl(provider, version, sysOs, archOption),
      tmpDownload,
      `no ${provider} ${version} download for ${releaseOs(sysOs)}/${archOption}`,
      onProgress,
    );
    onDownloadEnd();

    log('info', 'Verifying SHA256 checksum...');
    await verifyChecksum(tmpDownload, provider, version, sysOs, archOption);
    log('ok', 'Checksum verified.');

    if (isRawBinary(provider)) {
      copyFileSync(tmpDownload, tmpBinary);
    } else {
      log('info', 'Extracting...');
      const zip = new AdmZip(tmpDownload);
      // The binary is the entry with no extension (or .exe); skip LICENSE, docs, etc.
      const entry = zip.getEntries().find(e => !e.isDirectory && ['', '.exe'].includes(path.extname(e.entryName).toLowerCase()));
      if (!entry) throw new TfvError(CODES.DOWNLOAD_FAILED, `no ${provider} binary found in the download`);
      writeFileSync(tmpBinary, entry.getData());
    }

    if (sysOs !== 'win32') chmodSync(tmpBinary, '755');
    renameSync(tmpBinary, binary);

    const archFile = path.join(getProviderStore(provider), 'arch.json');
    const archMap = JSON.parse(readFileSync(archFile, 'utf-8'));
    archMap[version] = archOption;
    writeFileSync(archFile, JSON.stringify(archMap, null, 2));
  } finally {
    for (const f of [tmpDownload, tmpBinary]) {
      try { unlinkSync(f); } catch { /* already gone */ }
    }
  }
};

module.exports = {
  installVersion,
  getAssetName,
  getDownloadUrl,
  getSha256Url,
  verifyChecksum,
  releaseOs,
};
