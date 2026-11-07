// tfv/core: the library behind the tfv CLI, also used by tfv-server.
// Nothing here prints or calls process.exit; failures throw TfvError.
const { existsSync } = require('fs');
const paths = require('../utils/paths');
const { findVersionFile, findHclConstraint } = require('../utils/versionFiles');
const { fetchAllVersions } = require('../modules/remote');
const { TfvError, CODES } = require('./errors');
const { installVersion } = require('./install');
const { resolveConstraint, isConstraint, findPinnedVersion, resolveExactVersion } = require('./resolve');

/**
 * Path of an installed version's binary, or null if it isn't installed.
 */
const binaryFor = (provider, version) => {
  const file = paths.getVersionFile(provider, version);
  return existsSync(file) ? file : null;
};

/**
 * Makes sure the version `dir` asks for is installed and returns its binary.
 * Does not change the active (`tfv use`) version, so it is safe to call from
 * many jobs at once.
 * Options: fallback ("latest" when nothing is pinned; otherwise throws NO_VERSION),
 * plus installVersion's log / onProgress options.
 * Returns { provider, version, binary, source: { file, version } | null }.
 */
const ensureVersion = async (dir, providerArg = 'terraform', options = {}) => {
  const { fallback, ...installOptions } = options;
  const provider = paths.normalizeProvider(providerArg);

  const source = findPinnedVersion(dir, provider);
  if (!source && !fallback) {
    throw new TfvError(CODES.NO_VERSION, `No ${provider} version pinned in ${dir}`, { provider, dir });
  }

  const version = await resolveExactVersion(provider, source ? source.version : fallback);
  const existing = binaryFor(provider, version);
  if (existing) return { provider, version, binary: existing, source };

  const installed = await installVersion(provider, version, installOptions);
  return { provider, version: installed.version, binary: installed.binary, source };
};

module.exports = {
  TfvError,
  CODES,
  ensureVersion,
  installVersion,
  binaryFor,
  findPinnedVersion,
  resolveExactVersion,
  resolveConstraint,
  isConstraint,
  findVersionFile,
  findHclConstraint,
  fetchAllVersions,
  normalizeProvider: paths.normalizeProvider,
  getCliName: paths.getCliName,
  getVersionArgs: paths.getVersionArgs,
  PROVIDER_NAMES: paths.PROVIDER_NAMES,
  getPaths: paths.getPaths,
};
