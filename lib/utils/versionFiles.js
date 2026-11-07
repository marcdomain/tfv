const fs = require('fs');
const { join } = require('path');

// Readers return the version string from a file's content, or null.

// First non-empty, non-comment line (tfenv, tofuenv, tfswitch rc files).
const firstLine = (content) =>
  content.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#')) || null;

// tfswitch's .tfswitch.toml: version = "1.9.0"
const tomlVersion = (content) => {
  const m = content.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
  return m ? m[1].trim() : null;
};

// asdf / mise .tool-versions: "terraform 1.9.0 1.8.5" (first version wins)
const toolVersions = (names) => (content) => {
  for (const raw of content.split(/\r?\n/)) {
    const [name, version] = raw.replace(/#.*/, '').trim().split(/\s+/);
    if (names.includes(name) && version) return version;
  }
  return null;
};

// Files tied to one provider, in priority order.
const SOURCES = {
  terraform: [
    ['.terraform-version', firstLine],
    ['.tfswitchrc', firstLine],
    ['.tfswitch.toml', tomlVersion],
    ['.tool-versions', toolVersions(['terraform'])],
  ],
  opentofu: [
    ['.opentofu-version', firstLine],
    ['.tofu-version', firstLine],
    ['.tool-versions', toolVersions(['opentofu', 'tofu'])],
  ],
};

// OpenTofu reads Terraform's pin file too when asked for explicitly
// (`tfv auto-switch -p tofu`), as tfv always has.
const OPENTOFU_FALLBACK = [['.terraform-version', firstLine]];

/**
 * Finds the pinned version for a provider in `dir`.
 * `strict` skips the OpenTofu fallback to .terraform-version.
 * Returns { file, version } or null.
 */
const findVersionFile = (dir, provider = 'terraform', { strict = false } = {}) => {
  const sources = provider === 'opentofu' && !strict
    ? [...SOURCES.opentofu, ...OPENTOFU_FALLBACK]
    : SOURCES[provider] || SOURCES.terraform;

  for (const [file, read] of sources) {
    let content;
    try {
      content = fs.readFileSync(join(dir, file), 'utf-8');
    } catch {
      continue;
    }
    const version = read(content);
    if (version) return { file, version };
  }
  return null;
};

module.exports = { findVersionFile };
