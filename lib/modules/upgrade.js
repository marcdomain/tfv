const { existsSync, readFileSync, readdirSync } = require('fs');
const { normalizeProvider, getProviderStore, getPaths, fixPathConflict } = require('../utils/paths');
const { fetchAllVersions } = require('./remote');
const { install } = require('./install');
const { use } = require('./use');
const { P_END, P_OK, P_INFO, P_WARN, P_ERROR } = require('../utils/colors');

/**
 * Upgrade to the latest available patch within a version series.
 *
 * tfv upgrade           → upgrades active version's patch (e.g. 1.6.3 → 1.6.7)
 * tfv upgrade 1.8       → installs + uses latest 1.8.x
 * tfv upgrade latest    → installs + uses absolute latest version
 */
exports.upgrade = async (target, providerArg = 'terraform') => {
  try {
    const provider = normalizeProvider(providerArg);
    const allVersions = await fetchAllVersions(provider);

    let seriesPrefix;

    if (!target || target === 'current') {
      // Determine from active version
      const paths = getPaths();
      if (!existsSync(paths.active)) {
        console.log(`${P_ERROR}No active ${provider} version. Run: tfv use <version>  first.${P_END}`);
        process.exit(1);
      }
      const active = JSON.parse(readFileSync(paths.active, 'utf-8'));
      const activeVersion = active[provider];
      if (!activeVersion) {
        console.log(`${P_ERROR}No active ${provider} version set.${P_END}`);
        process.exit(1);
      }
      const parts = activeVersion.split('.');
      seriesPrefix = `${parts[0]}.${parts[1]}`;
      console.log(`${P_INFO}Upgrading ${provider} ${activeVersion} (${seriesPrefix}.x series)...${P_END}`);
    } else if (target === 'latest') {
      const latest = allVersions[0];
      console.log(`${P_INFO}Latest available ${provider} version: ${latest}${P_END}`);
      const installed = await install(latest, null, providerArg);
      if (installed) await use(installed, provider);
      return;
    } else {
      // Target is a series like "1.8" or "1.8.0"
      const parts = target.split('.');
      seriesPrefix = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : `${parts[0]}`;
      console.log(`${P_INFO}Finding latest ${provider} in ${seriesPrefix}.x series...${P_END}`);
    }

    const seriesVersions = allVersions.filter(v => v.startsWith(`${seriesPrefix}.`));
    if (seriesVersions.length === 0) {
      console.log(`${P_ERROR}No versions found in ${seriesPrefix}.x series${P_END}`);
      process.exit(1);
    }

    const latestInSeries = seriesVersions[0]; // Already sorted descending

    // Check if already on latest
    const paths = getPaths();
    if (existsSync(paths.active)) {
      const active = JSON.parse(readFileSync(paths.active, 'utf-8'));
      if (active[provider] === latestInSeries) {
        console.log(`${P_OK}Already on latest ${provider} in ${seriesPrefix}.x series: ${latestInSeries}${P_END}`);
        return;
      }
    }

    // Check if already in store
    const store = getProviderStore(provider);
    const inStore = readdirSync(store)
      .filter(f => f !== 'arch.json')
      .map(f => f.replace('.exe', ''))
      .includes(latestInSeries);

    if (inStore) {
      console.log(`${P_INFO}${provider} ${latestInSeries} already installed, switching...${P_END}`);
      await use(latestInSeries, provider);
    } else {
      console.log(`${P_INFO}Installing ${provider} ${latestInSeries}...${P_END}`);
      const installed = await install(latestInSeries, null, providerArg);
      if (installed) await use(installed, provider);
    }

    // Re-run PATH setup on upgrade in case a system tool (brew/apt) was
    // installed after tfv and is now shadowing ~/.tfv/bin
    fixPathConflict();

  } catch (err) {
    console.log(`${P_ERROR}Upgrade failed: ${err.message}${P_END}`);
    process.exit(1);
  }
};
