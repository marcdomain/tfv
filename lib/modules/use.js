const os = require('os');
const { existsSync, readdirSync, copyFileSync, readFileSync, writeFileSync } = require('fs');
const {
  normalizeProvider, getCliName, getProviderStore,
  getBinTarget, getVersionFile, getPaths, initDirs
} = require('../utils/paths');
const { checkStore } = require('../utils/store');
const { ensureWindowsPath } = require('./ps1');
const { P_END, P_OK, P_INFO, P_ERROR } = require('../utils/colors');

exports.use = async (tfVer, providerArg = 'terraform') => {
  try {
    initDirs();

    const provider = normalizeProvider(providerArg);
    checkStore(provider);

    const store = getProviderStore(provider);
    const isWin = os.platform() === 'win32';
    let version = tfVer;

    if (version === 'latest') {
      const files = readdirSync(store)
        .filter(f => f !== 'arch.json')
        .map(f => f.replace('.exe', ''));

      version = files.sort((a, b) => {
        const aParts = a.split('.').map(n => parseInt(n, 10) || 0);
        const bParts = b.split('.').map(n => parseInt(n, 10) || 0);
        for (let i = 0; i < 3; i++) {
          const diff = (bParts[i] || 0) - (aParts[i] || 0);
          if (diff !== 0) return diff;
        }
        return 0;
      })[0];

      console.log(`${P_INFO}Latest installed ${provider} version: ${version}${P_END}`);
    }

    const source = getVersionFile(provider, version);

    if (!existsSync(source)) {
      console.log(`${P_ERROR}${provider} ${version} is not installed${P_END}`);
      const pFlag = providerArg === 'terraform' ? '' : ` --provider ${providerArg}`;
      return console.log(`To install, run: ${P_OK}tfv install ${version}${pFlag}${P_END}`);
    }

    console.log(`${P_INFO}Switching to ${provider} ${version}...${P_END}`);

    const destination = getBinTarget(provider);
    copyFileSync(source, destination);

    if (!isWin) {
      const { chmodSync } = require('fs');
      chmodSync(destination, '755');
    }

    // Update active.json
    const paths = getPaths();
    const active = existsSync(paths.active)
      ? JSON.parse(readFileSync(paths.active, 'utf-8'))
      : { terraform: null, opentofu: null };
    active[provider] = version;
    writeFileSync(paths.active, JSON.stringify(active, null, 2));

    // Ensure ~/.tfv/bin is on PATH for Windows (idempotent)
    if (isWin) ensureWindowsPath();

    console.log(`${P_OK}Now using ${provider} ${version}${P_END}`);

  } catch (err) {
    console.log(`${P_ERROR}Error: ${err.message}${P_END}`);
    process.exit(1);
  }
};
