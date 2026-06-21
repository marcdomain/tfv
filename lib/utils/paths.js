const { homedir, platform } = require('os');
const { join } = require('path');
const { mkdirSync, existsSync, writeFileSync, readFileSync } = require('fs');

const TFV_HOME = join(homedir(), '.tfv');

const PROVIDERS = { terraform: 'terraform', tf: 'terraform', tofu: 'opentofu', opentofu: 'opentofu' };

const normalizeProvider = (provider = 'terraform') => PROVIDERS[provider] || 'terraform';

const getCliName = (provider) => normalizeProvider(provider) === 'opentofu' ? 'tofu' : 'terraform';

const getPaths = () => ({
  home: TFV_HOME,
  bin: join(TFV_HOME, 'bin'),
  store: join(TFV_HOME, 'store'),
  cache: join(TFV_HOME, 'cache'),
  terraform: join(TFV_HOME, 'store', 'terraform'),
  opentofu: join(TFV_HOME, 'store', 'opentofu'),
  active: join(TFV_HOME, 'active.json'),
});

const getProviderStore = (provider = 'terraform') => {
  const normalized = normalizeProvider(provider);
  return join(TFV_HOME, 'store', normalized);
};

const getBinTarget = (provider = 'terraform') => {
  const cli = getCliName(provider);
  const isWin = platform() === 'win32';
  return join(TFV_HOME, 'bin', isWin ? `${cli}.exe` : cli);
};

const getVersionFile = (provider, version) => {
  const store = getProviderStore(provider);
  const isWin = platform() === 'win32';
  return join(store, isWin ? `${version}.exe` : version);
};

const initDirs = () => {
  const paths = getPaths();
  [paths.home, paths.bin, paths.terraform, paths.opentofu, paths.cache].forEach(dir => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  });

  ['terraform', 'opentofu'].forEach(p => {
    const archFile = join(paths[p], 'arch.json');
    if (!existsSync(archFile)) writeFileSync(archFile, '{}');
  });

  if (!existsSync(paths.active)) {
    writeFileSync(paths.active, JSON.stringify({ terraform: null, opentofu: null }, null, 2));
  }
};

const SHELL_CONFIGS = [
  join(homedir(), '.zshrc'),
  join(homedir(), '.bashrc'),
  join(homedir(), '.bash_profile'),
  join(homedir(), '.profile'),
];
const PATH_MARKER = '# tfv - terraform version manager';
const PATH_LINE = 'export PATH="$HOME/.tfv/bin:$PATH"';

/**
 * Checks whether the shell-resolved binary (via `which`/`where`) matches
 * the tfv-managed binary at ~/.tfv/bin/<cli>.
 * Returns { ok: true } or { ok: false, resolved, expected }.
 */
const checkPathConflict = (provider = 'terraform') => {
  const { spawnSync } = require('child_process');
  const isWin = platform() === 'win32';
  const cli = getCliName(provider);
  const expected = getBinTarget(provider);

  const result = isWin
    ? spawnSync('where', [cli], { stdio: 'pipe', encoding: 'utf-8', shell: true })
    : spawnSync('which', [cli], { stdio: 'pipe', encoding: 'utf-8' });

  if (!result || result.status !== 0 || !result.stdout.trim()) {
    return { ok: true }; // not found anywhere else — no conflict
  }

  const resolved = result.stdout.trim().split('\n')[0].trim();
  if (resolved === expected) return { ok: true };

  return { ok: false, resolved, expected };
};

/**
 * Fixes a PATH conflict automatically.
 *
 * macOS / Linux:
 *   Removes any existing tfv PATH block from shell configs, then re-appends
 *   it at the very END so it runs after brew/apt/other tools and always wins.
 *
 * Windows:
 *   Moves ~/.tfv/bin to the front of the User PATH in the registry (no admin needed).
 */
const fixPathConflict = () => {
  const isWin = platform() === 'win32';

  if (isWin) {
    const { spawnSync } = require('child_process');
    const BIN_DIR = join(TFV_HOME, 'bin');

    const get = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        '[Environment]::GetEnvironmentVariable("PATH", "User")'],
      { stdio: 'pipe', encoding: 'utf-8' }
    );

    const current = (get.stdout || '').trim();
    const entries = current.split(';').map(p => p.trim()).filter(p => p && p !== BIN_DIR);
    const fixed = [BIN_DIR, ...entries].join(';');

    spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `[Environment]::SetEnvironmentVariable("PATH", "${fixed}", "User")`],
      { stdio: 'pipe' }
    );
    return;
  }

  // macOS / Linux — update each shell config file
  const block = `\n${PATH_MARKER}\n${PATH_LINE}\n`;

  SHELL_CONFIGS.forEach(file => {
    if (!existsSync(file)) return;

    // Strip any existing tfv PATH block
    let content = readFileSync(file, 'utf-8');
    content = content.replace(
      new RegExp(`\\n?${PATH_MARKER}\\n${PATH_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`, 'g'),
      ''
    );

    // Append at the very end so it always runs last and wins
    writeFileSync(file, content.trimEnd() + block);
  });
};

module.exports = {
  TFV_HOME,
  getPaths,
  getProviderStore,
  getBinTarget,
  getVersionFile,
  normalizeProvider,
  getCliName,
  initDirs,
  checkPathConflict,
  fixPathConflict,
};
