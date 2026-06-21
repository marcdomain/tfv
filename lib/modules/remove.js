const os = require('os');
const { existsSync, unlinkSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { normalizeProvider, getProviderStore, getVersionFile, getPaths } = require('../utils/paths');
const { P_END, P_OK, P_ERROR, P_WARN } = require('../utils/colors');

exports.remove = async (versions, providerArg = 'terraform') => {
  try {
    const provider = normalizeProvider(providerArg);
    const store = getProviderStore(provider);

    const archFile = join(store, 'arch.json');
    const archMap = existsSync(archFile) ? JSON.parse(readFileSync(archFile, 'utf-8')) : {};

    // Get active version for warning
    const paths = getPaths();
    let activeVersion = null;
    if (existsSync(paths.active)) {
      const active = JSON.parse(readFileSync(paths.active, 'utf-8'));
      activeVersion = active[provider];
    }

    versions.forEach(v => {
      const file = getVersionFile(provider, v);

      if (!existsSync(file)) {
        return console.log(`${P_ERROR}${provider} ${v} is not in tfv store${P_END}`);
      }

      if (v === activeVersion) {
        console.log(`${P_WARN}Warning: ${provider} ${v} is currently active. Removing it will break the active symlink.${P_END}`);
        console.log(`${P_WARN}Run ${P_OK}tfv use <other-version>${P_END}${P_WARN} first, or reinstall after removal.${P_END}`);
      }

      unlinkSync(file);
      delete archMap[v];
      console.log(`${P_OK}Removed ${provider} ${v} from tfv store${P_END}`);
    });

    writeFileSync(archFile, JSON.stringify(archMap, null, 2));
  } catch (err) {
    console.log(`${P_ERROR}Error: ${err.message}${P_END}`);
  }
};
