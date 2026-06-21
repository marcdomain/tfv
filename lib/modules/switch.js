const fs = require('fs');
const { join } = require('path');
const { use } = require('./use');
const { install } = require('./install');
const { normalizeProvider, getProviderStore, initDirs } = require('../utils/paths');
const { P_END, P_ERROR, P_INFO } = require('../utils/colors');

/**
 * Resolve required_version constraint to an exact version number.
 * Handles: =, ==, >=, >, ~>, and compound constraints (">= 1.3, < 2.0")
 */
const resolveConstraint = (constraint, versions) => {
  // Normalize: remove spaces around operators
  const parts = constraint.split(',').map(s => s.trim());

  return versions.find(v => {
    return parts.every(part => {
      const m = part.match(/^(~>|>=|<=|!=|>|<|=)?\s*(\d+(?:\.\d+)*)/);
      if (!m) return false;
      const [, op = '=', req] = m;

      const vParts = v.split('.').map(n => parseInt(n, 10) || 0);
      const rParts = req.split('.').map(n => parseInt(n, 10) || 0);

      const cmp = () => {
        for (let i = 0; i < 3; i++) {
          const diff = (vParts[i] || 0) - (rParts[i] || 0);
          if (diff !== 0) return diff;
        }
        return 0;
      };

      switch (op) {
        case '~>': {
          // pessimistic: allow patch or minor bumps only at the last specified segment
          const segCount = rParts.length;
          // major.minor segments must match, only patch can increase
          for (let i = 0; i < segCount - 1; i++) {
            if ((vParts[i] || 0) !== (rParts[i] || 0)) return false;
          }
          return (vParts[segCount - 1] || 0) >= (rParts[segCount - 1] || 0);
        }
        case '>=': return cmp() >= 0;
        case '>':  return cmp() > 0;
        case '<=': return cmp() <= 0;
        case '<':  return cmp() < 0;
        case '!=': return cmp() !== 0;
        default:   return cmp() === 0;
      }
    });
  }) || null;
};

exports.autoSwitch = async (options = {}, providerArg = 'terraform') => {
  const { silent = false } = options;
  const log = silent ? () => {} : console.log;

  try {
    initDirs();
    const provider = normalizeProvider(providerArg);

    let versionFile;
    let tfVersion;

    // 1. Check .terraform-version file first (tfenv compatibility)
    const dotVersionFile = join(process.cwd(), '.terraform-version');
    if (fs.existsSync(dotVersionFile)) {
      const pinned = fs.readFileSync(dotVersionFile, 'utf-8').trim();
      if (pinned) {
        versionFile = '.terraform-version';
        tfVersion = pinned;
      }
    }

    // 2. Check terraform.tfstate for version
    if (!tfVersion) {
      const tfState = 'terraform.tfstate';
      if (fs.existsSync(tfState)) {
        versionFile = tfState;
        tfVersion = JSON.parse(fs.readFileSync(tfState, 'utf-8'))['terraform_version'];
      }
    }

    // 3. Scan .tf files for required_version
    if (!tfVersion) {
      const allFiles = fs.readdirSync(process.cwd());
      const priority = ['main.tf', 'provider.tf', 'providers.tf', 'versions.tf', 'version.tf', 'backend.tf', 'terraform.tf'];
      const tfFiles = [
        ...allFiles.filter(f => priority.includes(f)),
        ...allFiles.filter(f => f.endsWith('.tf') && !priority.includes(f)),
      ];

      const pattern = /required_version\s*=\s*"([^"]+)"/m;

      for (const file of tfFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        const match = content.match(pattern);
        if (match) {
          versionFile = file;
          tfVersion = match[1].trim();
          break;
        }
      }
    }

    if (!tfVersion) {
      log(`${P_ERROR}No terraform version found.${P_END}`);
      log(`Create a .terraform-version file or set required_version in a .tf file.`);
      return;
    }

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
