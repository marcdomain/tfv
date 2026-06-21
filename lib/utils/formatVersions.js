/**
 * Parse Terraform versions from HashiCorp JSON API response.
 * API: https://releases.hashicorp.com/terraform/index.json
 * Returns sorted array of STABLE version strings only (descending).
 * Use formatAllVersions() to include pre-releases.
 */
exports.formatVersions = (jsonData) => {
  const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
  return Object.keys(data.versions || {})
    .filter(v => !v.includes('-'))   // stable only: exclude 1.8.0-beta1, rc1, alpha etc.
    .sort(semverDesc);
};

/**
 * Same as formatVersions but includes pre-release builds.
 * Used when user explicitly requests a pre-release version.
 */
exports.formatAllVersions = (jsonData) => {
  const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
  return Object.keys(data.versions || {}).sort(semverDesc);
};

/**
 * Parse OpenTofu versions from GitHub releases API response.
 * API: https://api.github.com/repos/opentofu/opentofu/releases
 * Returns sorted array of STABLE version strings only (descending).
 */
exports.formatOpenTofuVersions = (jsonData) => {
  const releases = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
  return releases
    .filter(r => !r.prerelease && !r.draft)
    .map(r => r.tag_name.replace(/^v/, ''))
    .filter(v => !v.includes('-'))   // extra guard for stable-only
    .sort(semverDesc);
};

/**
 * Same as formatOpenTofuVersions but includes pre-release builds.
 */
exports.formatAllOpenTofuVersions = (jsonData) => {
  const releases = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
  return releases
    .filter(r => !r.draft)
    .map(r => r.tag_name.replace(/^v/, ''))
    .sort(semverDesc);
};

const semverDesc = (a, b) => {
  const aParts = a.split('.').map(n => parseInt(n, 10) || 0);
  const bParts = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (bParts[i] || 0) - (aParts[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

exports.semverDesc = semverDesc;
