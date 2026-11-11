// Downloads, verifies and stores a terraform / opentofu / terragrunt version.
// Library code: never prints and never exits. Progress goes through `log`
// and `onProgress`; failures throw TeriacError.
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const {
  chmodSync, copyFileSync, existsSync, unlinkSync, renameSync,
  readFileSync, writeFileSync, createWriteStream,
} = require('fs');
const AdmZip = require('adm-zip');
const { applyMirror, clientFor } = require('../utils/mirror');
const { fetchAllVersions, fetchUrl, fetchBuffer } = require('../modules/remote');
const { verifyDetached } = require('./pgp');
const { env } = require('../utils/env');
const { normalizeProvider, getProviderStore, getVersionFile, initDirs } = require('../utils/paths');
const { TeriacError, CODES } = require('./errors');
const { headersFor, withRetry, IDLE_TIMEOUT_MS } = require('../utils/net');

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

// Who signs each tool's checksum file, and where the signature lives. Terragrunt only
// signs releases from early 2026 on, so an older one without a signature is allowed.
const SIGNING = {
  terraform: { vendor: 'HashiCorp', key: 'hashicorp.asc', ext: '.sig', required: true },
  opentofu: { vendor: 'OpenTofu', key: 'opentofu.asc', ext: '.gpgsig', required: true },
  terragrunt: { vendor: 'Gruntwork', key: 'terragrunt.asc', ext: '.gpgsig', required: false },
};
const KEYS_DIR = path.join(__dirname, 'keys');

// Checks that the checksum file is signed by the tool's vendor (TERIAC_VERIFY_SIGNATURES=false turns it off).
const verifySignature = async (provider, version, sumsData, log = noop) => {
  if (env('VERIFY_SIGNATURES') === 'false') return 'off';
  const s = SIGNING[provider];
  const url = `${getSha256Url(provider, version)}${s.ext}`;
  let sig;
  try {
    sig = await fetchBuffer(url);
  } catch (err) {
    if (err.status === 404 && !s.required) {
      log('info', `${provider} ${version} publishes no signature; checked against its checksum only.`);
      return 'unsigned';
    }
    if (err.status === 404) {
      throw new TeriacError(CODES.SIGNATURE_FAILED,
        `No signature found for the ${provider} ${version} checksums (${url}). If you use a mirror that doesn't copy signature files, set TERIAC_VERIFY_SIGNATURES=false.`);
    }
    throw new TeriacError(CODES.DOWNLOAD_FAILED, `Could not download the checksum signature: ${err.message}`);
  }
  try {
    verifyDetached(Buffer.from(sumsData, 'utf8'), sig, [readFileSync(path.join(KEYS_DIR, s.key), 'utf8')]);
  } catch (err) {
    throw new TeriacError(CODES.SIGNATURE_FAILED,
      `The ${provider} ${version} checksum file is not signed by ${s.vendor} (${err.message}). The download was refused.`);
  }
  return 'verified';
};

const verifyChecksum = async (filePath, provider, version, sysOs, archOption, log = noop) => {
  const sumsData = await fetchUrl(getSha256Url(provider, version));
  const signature = await verifySignature(provider, version, sumsData, log);
  if (signature === 'verified') log('ok', `Signature verified (${SIGNING[provider].vendor}).`);
  const assetName = getAssetName(provider, version, sysOs, archOption);
  // Match the file name exactly: terragrunt also lists foo.zip and foo.tar.gz.
  const entry = sumsData.split('\n')
    .map(l => l.trim().split(/\s+/))
    .find(([, name]) => name && name.replace(/^\*/, '') === assetName);

  if (!entry) throw new TeriacError(CODES.CHECKSUM_FAILED, `Checksum entry not found for ${assetName}`);

  const [expectedHash] = entry;
  const actualHash = crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex');
  if (actualHash !== expectedHash) {
    throw new TeriacError(CODES.CHECKSUM_FAILED,
      `SHA256 mismatch!\n  Expected: ${expectedHash}\n  Got:      ${actualHash}`);
  }
};

// Streams `url` to `dest`, following one redirect (GitHub releases go to a CDN).
const downloadOnce = (url, dest, failMessage, onProgress) => new Promise((resolve, reject) => {
  const fail = (err) => reject(err instanceof TeriacError ? err : new TeriacError(CODES.DOWNLOAD_FAILED, err.message));
  let settled = false;
  const done = (fn) => (...a) => { if (!settled) { settled = true; fn(...a); } };
  const ok = done(resolve);
  const bad = done(fail);

  const handleResponse = (res) => {
    if (res.statusCode >= 400) {
      res.resume();
      return bad(new TeriacError(CODES.DOWNLOAD_FAILED, `${failMessage} (HTTP ${res.statusCode})`));
    }
    const total = parseInt(res.headers['content-length'], 10);
    let received = 0;
    const fileStream = createWriteStream(dest); // truncates: a retry starts from scratch
    res.on('data', chunk => {
      received += chunk.length;
      onProgress(received, total);
    });
    res.on('error', bad);
    res.pipe(fileStream);
    fileStream.on('error', bad);
    fileStream.on('finish', () => {
      fileStream.close();
      if (Number.isFinite(total) && received < total) return bad(new Error(`${failMessage}: connection dropped (ECONNRESET) after ${received} of ${total} bytes`));
      ok();
    });
  };

  // Each hop gets its own headers: the GitHub token never goes to the storage host.
  const get = (target, onRes) => {
    const req = clientFor(target).get(target, { headers: headersFor(target) }, onRes);
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`${failMessage}: timed out after ${IDLE_TIMEOUT_MS / 1000}s`)));
    req.on('error', bad);
  };
  get(url, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return get(new URL(res.headers.location, url).href, handleResponse);
    }
    handleResponse(res);
  });
});

// Temporary failures (GitHub 5xx, dropped or stalled connections) are retried.
const download = (url, dest, failMessage, onProgress, log = noop) => withRetry(
  () => downloadOnce(url, dest, failMessage, onProgress),
  { onRetry: (err, attempt, wait) => log('warn', `${err.message}; retrying in ${Math.round(wait / 1000)}s (attempt ${attempt + 1} of 4)`) },
);

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
      throw new TeriacError(CODES.VERSION_LIST_UNAVAILABLE,
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
    throw new TeriacError(CODES.VERSION_NOT_FOUND, `${provider} ${version} not found.`, { provider, version });
  }
  return version;
};

// The tool's binary inside a release zip, matched by name: zips also hold
// LICENSE, which has no extension either.
const findBinaryEntry = (entries, provider) => {
  const cli = provider === 'opentofu' ? 'tofu' : 'terraform';
  return entries.find(e => !e.isDirectory && [cli, `${cli}.exe`].includes(path.basename(e.entryName).toLowerCase())) || null;
};

// Several jobs (teriac-server) may ask for the same version at once:
// share one download per provider@version within this process.
const inflight = new Map();

/**
 * Installs a version into the teriac store.
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
  const tmpDownload = path.join(os.tmpdir(), `teriac-${provider}-${version}-${unique}.download`);
  // Written next to the final file, then renamed, so readers never see half a binary.
  const tmpBinary = `${binary}.${unique}.tmp`;

  try {
    log('info', `Downloading ${provider} ${version} (${archOption})...`);
    await download(
      getDownloadUrl(provider, version, sysOs, archOption),
      tmpDownload,
      `no ${provider} ${version} download for ${releaseOs(sysOs)}/${archOption}`,
      onProgress,
      log,
    );
    onDownloadEnd();

    log('info', 'Verifying signature and SHA256 checksum...');
    await verifyChecksum(tmpDownload, provider, version, sysOs, archOption, log);
    log('ok', 'Checksum verified.');

    if (isRawBinary(provider)) {
      copyFileSync(tmpDownload, tmpBinary);
    } else {
      log('info', 'Extracting...');
      const zip = new AdmZip(tmpDownload);
      const entry = findBinaryEntry(zip.getEntries(), provider);
      if (!entry) throw new TeriacError(CODES.DOWNLOAD_FAILED, `no ${provider} binary found in the download`);
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
  verifySignature,
  releaseOs,
  findBinaryEntry,
};
