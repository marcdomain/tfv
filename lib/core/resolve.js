// Works out which version a directory needs. Library code: no printing.
const fs = require('fs');
const { join } = require('path');
const { normalizeProvider } = require('../utils/paths');
const { findVersionFile, findHclConstraint } = require('../utils/versionFiles');
const { fetchAllVersions } = require('../modules/remote');
const { TfvError, CODES } = require('./errors');

/**
 * Resolves a required_version constraint against `versions` (newest first).
 * Handles: =, ==, >=, >, <=, <, !=, ~> and compound constraints (">= 1.3, < 2.0").
 * Returns the newest matching version or null.
 */
const resolveConstraint = (constraint, versions) => {
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
          // Pessimistic: only the last specified segment may increase.
          const segCount = rParts.length;
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

const isConstraint = (version) => /[><=~!,]/.test(version);

// .tf files that usually hold the terraform block, checked first.
const PRIORITY_TF = ['main.tf', 'provider.tf', 'providers.tf', 'versions.tf', 'version.tf', 'backend.tf', 'terraform.tf'];

/**
 * Finds the version pinned for `provider` in `dir`, in tfv's usual order:
 *   1. version files (.terraform-version, .opentofu-version, .tool-versions, ...)
 *      and, for terragrunt, terragrunt_version_constraint in terragrunt.hcl
 *   2. terraform.tfstate
 *   3. required_version in .tf files
 *   4. terraform_version_constraint in terragrunt.hcl / root.hcl
 * `strict` stops after step 1 (shell hook), as does terragrunt.
 * Returns { file, version } (version may be a constraint) or null.
 */
const findPinnedVersion = (dir, providerArg = 'terraform', { strict = false } = {}) => {
  const provider = normalizeProvider(providerArg);

  const pinned = findVersionFile(dir, provider, { strict });
  if (pinned) return pinned;

  if (provider === 'terragrunt') {
    const found = findHclConstraint(dir, 'terragrunt_version_constraint');
    if (found) return found;
  }
  if (strict || provider === 'terragrunt') return null;

  const tfState = join(dir, 'terraform.tfstate');
  if (fs.existsSync(tfState)) {
    const version = JSON.parse(fs.readFileSync(tfState, 'utf-8')).terraform_version;
    if (version) return { file: 'terraform.tfstate', version };
  }

  const allFiles = fs.readdirSync(dir);
  const tfFiles = [
    ...allFiles.filter(f => PRIORITY_TF.includes(f)),
    ...allFiles.filter(f => f.endsWith('.tf') && !PRIORITY_TF.includes(f)),
  ];
  for (const file of tfFiles) {
    const match = fs.readFileSync(join(dir, file), 'utf-8').match(/required_version\s*=\s*"([^"]+)"/m);
    if (match) return { file, version: match[1].trim() };
  }

  return findHclConstraint(dir, 'terraform_version_constraint');
};

/**
 * Turns a pinned value into one exact version:
 *   "1.9.8"            → "1.9.8"
 *   ">= 1.5, < 2.0"    → newest matching release
 *   "1.9" (a prefix)   → newest 1.9.x release
 * `versions` (newest first) can be passed to skip the network.
 */
const resolveExactVersion = async (providerArg, value, { versions } = {}) => {
  const provider = normalizeProvider(providerArg);
  const wanted = `${value}`.trim().replace(/^v/, '');
  if (/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(wanted)) return wanted;

  const list = versions || await fetchAllVersions(provider);
  const resolved = isConstraint(wanted)
    ? resolveConstraint(wanted, list)
    : list.find(v => v === wanted || v.startsWith(`${wanted}.`));

  if (!resolved) {
    throw new TfvError(CODES.NO_MATCH, `No ${provider} version satisfies "${value}"`, { provider, constraint: value });
  }
  return resolved;
};

module.exports = { resolveConstraint, isConstraint, findPinnedVersion, resolveExactVersion };
