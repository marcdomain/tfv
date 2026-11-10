const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('fs');
const os = require('os');

// Looked up on each call (not destructured) so tests can point it elsewhere.
const homedir = () => os.homedir();
const platform = () => os.platform();
const { join } = require('path');
const { P_END, P_OK, P_WARN, P_INFO, P_ERROR } = require('../utils/colors');

const MARKER = '# teriac plugin cache';
const SETTING_RE = /^\s*plugin_cache_dir\s*=\s*"([^"]*)"/m;
const BLOCK_RE = /\n?# teriac plugin cache\n\s*plugin_cache_dir\s*=\s*"[^"]*"\n?/g;

const isWin = () => platform() === 'win32';
const appData = () => process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');

// HashiCorp's conventional location, so the setting still works without teriac.
const cacheDir = () => (isWin()
  ? join(appData(), 'terraform.d', 'plugin-cache')
  : join(homedir(), '.terraform.d', 'plugin-cache'));

// CLI config files. OpenTofu falls back to Terraform's file when its own is
// missing, so tofu's file is only edited if the user already has one;
// creating it would hide the rest of their Terraform config from tofu.
const configFiles = () => [
  { tool: 'terraform', file: isWin() ? join(appData(), 'terraform.rc') : join(homedir(), '.terraformrc'), create: true },
  { tool: 'opentofu', file: isWin() ? join(appData(), 'tofu.rc') : join(homedir(), '.tofurc'), create: false },
];

const read = (file) => (existsSync(file) ? readFileSync(file, 'utf-8') : '');
const toHclPath = (p) => p.replace(/\\/g, '/');
const short = (p) => p.replace(homedir(), '~');

const countEntries = (dir) => {
  try {
    return readdirSync(dir, { recursive: true }).length;
  } catch {
    return 0;
  }
};

const on = () => {
  const dir = cacheDir();
  mkdirSync(dir, { recursive: true });
  const line = `plugin_cache_dir = "${toHclPath(dir)}"`;

  for (const { tool, file, create } of configFiles()) {
    const content = read(file);
    if (!content && !create) {
      console.log(`${P_INFO}–  ${tool}: no ${short(file)}, it uses the Terraform config above${P_END}`);
      continue;
    }
    if (content.includes(MARKER)) {
      console.log(`${P_OK}✔  ${tool}: already on (${short(file)})${P_END}`);
      continue;
    }
    const existing = content.match(SETTING_RE);
    if (existing) {
      console.log(`${P_WARN}–  ${tool}: ${short(file)} already sets plugin_cache_dir = "${existing[1]}", leaving it${P_END}`);
      continue;
    }
    writeFileSync(file, `${content.trimEnd()}${content.trim() ? '\n\n' : ''}${MARKER}\n${line}\n`);
    console.log(`${P_OK}✔  ${tool}: enabled in ${short(file)}${P_END}`);
  }
  console.log(`${P_INFO}Providers are now downloaded once into ${short(dir)} and reused by every project.${P_END}`);
};

const off = () => {
  for (const { tool, file } of configFiles()) {
    const content = read(file);
    if (content.includes(MARKER)) {
      const rest = content.replace(BLOCK_RE, '\n').replace(/\n{3,}/g, '\n\n').trim();
      writeFileSync(file, rest ? `${rest}\n` : '');
      console.log(`${P_OK}✔  ${tool}: removed from ${short(file)}${P_END}`);
    } else if (SETTING_RE.test(content)) {
      console.log(`${P_WARN}–  ${tool}: ${short(file)} sets plugin_cache_dir itself (not added by teriac), leaving it${P_END}`);
    }
  }
  console.log(`${P_INFO}Cached providers are kept in ${short(cacheDir())}; delete the folder to free space.${P_END}`);
};

const status = () => {
  if (process.env.TF_PLUGIN_CACHE_DIR) {
    console.log(`${P_INFO}TF_PLUGIN_CACHE_DIR is set: ${process.env.TF_PLUGIN_CACHE_DIR} (overrides config files)${P_END}`);
  }
  for (const { tool, file, create } of configFiles()) {
    if (!create && !existsSync(file)) {
      console.log(`  ${tool.padEnd(10)} ${'same as terraform'.padEnd(20)} (no ${short(file)})`);
      continue;
    }
    const m = read(file).match(SETTING_RE);
    const how = !m ? 'off' : read(file).includes(MARKER) ? 'on (managed by teriac)' : 'on (set by you)';
    console.log(`  ${tool.padEnd(10)} ${how.padEnd(20)} ${short(file)}${m ? `  →  ${m[1]}` : ''}`);
  }
  const dir = cacheDir();
  if (existsSync(dir)) console.log(`${P_INFO}Cache: ${short(dir)} (${countEntries(dir)} entries)${P_END}`);
};

exports.pluginCache = (action = 'status') => {
  try {
    ({ on, off, status })[action]();
  } catch (err) {
    console.log(`${P_ERROR}plugin-cache error: ${err.message}${P_END}`);
    process.exit(1);
  }
};

exports._internals = { cacheDir, configFiles, MARKER };
