const { installVersion } = require('../core/install');
const { CODES } = require('../core/errors');
const { providerFlag } = require('../utils/paths');
const { P_END, P_ERROR, P_INFO, P_OK, P_WARN } = require('../utils/colors');

const COLORS = { info: P_INFO, ok: P_OK, warn: P_WARN };
const log = (level, message) => console.log(`${COLORS[level] || ''}${message}${P_END}`);

const showProgress = (received, total) => {
  if (!total) return;
  const pct = Math.min(100, Math.floor((received / total) * 100));
  const filled = Math.floor(pct / 2);
  const bar = '█'.repeat(filled) + '░'.repeat(50 - filled);
  process.stdout.write(`\r  [${bar}] ${pct}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
};

// CLI wrapper around core installVersion: prints progress and exits on failure.
exports.install = async (requested, sysArchitecture, providerArg = 'terraform') => {
  try {
    const result = await installVersion(providerArg, requested, {
      arch: sysArchitecture,
      log,
      onProgress: showProgress,
      onDownloadEnd: () => process.stdout.write('\n'),
    });
    const { provider, version } = result;

    if (result.alreadyInstalled) {
      console.log(`${P_WARN}${provider} ${version} is already installed${P_END}`);
      return console.log(`To use this version run: ${P_OK}tfv use ${version}${providerFlag(providerArg)}${P_END}`);
    }

    console.log(`${P_OK}Installed ${provider} ${version} successfully!${P_END}`);
    console.log(`To use this version run: ${P_OK}tfv use ${version}${providerFlag(providerArg)}${P_END}`);
    return version;

  } catch (err) {
    if (err.code === CODES.VERSION_NOT_FOUND) {
      console.log(`${P_ERROR}${err.message}${P_END}`);
      console.log(`To view available versions, run ${P_OK}tfv list --remote${providerFlag(providerArg)}${P_END}`);
      process.exit(1);
    }
    console.log(`${P_ERROR}Install failed: ${err.message}${P_END}`);
    process.exit(1);
  }
};
