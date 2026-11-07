const fs = require('fs');
const { use } = require('./use');
const { install } = require('./install');
const { normalizeProvider, getProviderStore, initDirs } = require('../utils/paths');
const { P_END, P_ERROR, P_INFO } = require('../utils/colors');
const { resolveConstraint, findPinnedVersion } = require('../core/resolve');

exports.autoSwitch = async (options = {}, providerArg = 'terraform') => {
  const { silent = false, strict = false } = options;
  const log = silent ? () => {} : console.log;

  try {
    initDirs();
    const provider = normalizeProvider(providerArg);

    // Version files, terraform.tfstate, required_version, terragrunt.hcl constraints.
    const pinned = findPinnedVersion(process.cwd(), provider, { strict });

    if (!pinned) {
      // Strict mode (shell hook) stays quiet when nothing is pinned.
      if (strict) return;
      if (provider === 'terragrunt') {
        log(`${P_ERROR}No terragrunt version found.${P_END}\nCreate a .terragrunt-version file or set terragrunt_version_constraint in terragrunt.hcl.`);
      } else {
        log(`${P_ERROR}No ${provider} version found.${P_END}`);
        log(`Create a ${provider === 'opentofu' ? '.opentofu-version' : '.terraform-version'} file or set required_version in a .tf file.`);
      }
      return;
    }
    const { file: versionFile, version: tfVersion } = pinned;

    log(`${P_INFO}Found version constraint "${tfVersion}" in: ${versionFile}${P_END}`);

    const store = getProviderStore(provider);
    const installedFiles = fs.readdirSync(store).filter(f => f !== 'arch.json');
    const installedVersions = installedFiles.map(f => f.replace('.exe', ''));

    // If exact version (no operators), use directly
    let resolved = tfVersion;
    if (/[><=~!,]/.test(tfVersion)) {
      const { fetchAllVersions } = require('./remote');
      const allVersions = await fetchAllVersions(provider);
      resolved = resolveConstraint(tfVersion, allVersions);

      if (!resolved) {
        log(`${P_ERROR}No ${provider} version satisfies constraint: ${tfVersion}${P_END}`);
        return;
      }
      log(`${P_INFO}Resolved to: ${resolved}${P_END}`);
    }

    const inStore = installedVersions.find(v => v === resolved || v.startsWith(resolved));
    if (inStore) {
      await use(inStore, provider);
    } else {
      log(`${P_INFO}${provider} ${resolved} not in store. Installing...${P_END}`);
      const installed = await install(resolved, null, provider);
      if (installed) await use(installed, provider);
    }

  } catch (err) {
    if (!options.silent) console.log(`${P_ERROR}auto-switch error: ${err.message}${P_END}`);
  }
};
