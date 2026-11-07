const { homedir, platform } = require('os');
const { join, dirname } = require('path');
const { mkdirSync, existsSync, writeFileSync, readFileSync } = require('fs');

const TFV_HOME = join(homedir(), '.tfv');

const PROVIDERS = {
  terraform: 'terraform', tf: 'terraform',
  tofu: 'opentofu', opentofu: 'opentofu',
  terragrunt: 'terragrunt', tg: 'terragrunt',
};

// Every tool tfv manages, and the command each one installs as.
const PROVIDER_NAMES = ['terraform', 'opentofu', 'terragrunt'];
const CLI_NAMES = { terraform: 'terraform', opentofu: 'tofu', terragrunt: 'terragrunt' };

const normalizeProvider = (provider = 'terraform') => PROVIDERS[provider] || 'terraform';

const getCliName = (provider) => CLI_NAMES[normalizeProvider(provider)];

// Args that print the tool's own version. `terragrunt version` is passed
// through to terraform/tofu, so terragrunt needs --version.
const getVersionArgs = (provider) =>
  normalizeProvider(provider) === 'terragrunt' ? ['--version'] : ['version'];

// " --provider tofu" style suffix for hints; empty for terraform.
const providerFlag = (provider) => {
  const p = normalizeProvider(provider);
  return p === 'terraform' ? '' : ` --provider ${CLI_NAMES[p]}`;
};

const getPaths = () => ({
  home: TFV_HOME,
  bin: join(TFV_HOME, 'bin'),
  store: join(TFV_HOME, 'store'),
  cache: join(TFV_HOME, 'cache'),
  terraform: join(TFV_HOME, 'store', 'terraform'),
  opentofu: join(TFV_HOME, 'store', 'opentofu'),
  terragrunt: join(TFV_HOME, 'store', 'terragrunt'),
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

const emptyActive = () => Object.fromEntries(PROVIDER_NAMES.map(p => [p, null]));

const initDirs = () => {
  const paths = getPaths();
  [paths.home, paths.bin, paths.cache, ...PROVIDER_NAMES.map(p => paths[p])].forEach(dir => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  });

  PROVIDER_NAMES.forEach(p => {
    const archFile = join(paths[p], 'arch.json');
    if (!existsSync(archFile)) writeFileSync(archFile, '{}');
  });

  if (!existsSync(paths.active)) {
    writeFileSync(paths.active, JSON.stringify(emptyActive(), null, 2));
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
  // Windows paths are case-insensitive
  const same = isWin ? resolved.toLowerCase() === expected.toLowerCase() : resolved === expected;
  if (same) return { ok: true };

  return { ok: false, resolved, expected };
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATH_BLOCK_RE = new RegExp(`\\n?${escapeRegex(PATH_MARKER)}\\n${escapeRegex(PATH_LINE)}\\n?`, 'g');

// Shell config to create when the user has none of SHELL_CONFIGS yet,
// picked from their login shell.
const defaultShellConfig = () => {
  const shell = (process.env.SHELL || '').split('/').pop();
  if (shell === 'zsh') return join(homedir(), '.zshrc');
  if (shell === 'bash') return join(homedir(), platform() === 'darwin' ? '.bash_profile' : '.bashrc');
  return join(homedir(), '.profile');
};

// fish ignores the files above, so it gets its own conf.d snippet.
const FISH_CONF = join(homedir(), '.config', 'fish', 'conf.d', 'tfv.fish');
const FISH_BLOCK = `${PATH_MARKER}\nfish_add_path --move --path "$HOME/.tfv/bin"\n`;

const usesFish = () =>
  (process.env.SHELL || '').endsWith('/fish') || existsSync(join(homedir(), '.config', 'fish'));

/**
 * Fixes a PATH conflict automatically. Safe to re-run.
 *
 * macOS / Linux:
 *   Removes any existing tfv PATH block from shell configs, then re-appends
 *   it at the very END so it runs after brew/apt/other tools and always wins.
 *   Creates a config for the user's shell if none exists, and adds a fish
 *   snippet for fish users.
 *
 * Windows:
 *   Moves ~/.tfv/bin to the front of the User PATH in the registry (no admin needed).
 *
 * Returns the list of files (or "User PATH") that were updated.
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

    // Never write PATH back if we couldn't read it: that would wipe it.
    if (get.error || get.status !== 0) {
      throw new Error('could not read your User PATH; add ~/.tfv/bin to PATH manually');
    }

    const current = (get.stdout || '').trim();
    const entries = current.split(';').map(p => p.trim()).filter(p => p && p !== BIN_DIR);
    const fixed = [BIN_DIR, ...entries].join(';');
    if (fixed === current) return ['User PATH'];

    // Single-quoted so PowerShell doesn't expand `$` in paths.
    const set = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `[Environment]::SetEnvironmentVariable('PATH', '${fixed.replace(/'/g, "''")}', 'User')`],
      { stdio: 'pipe' }
    );
    if (set.error || set.status !== 0) {
      throw new Error('could not update your User PATH; add ~/.tfv/bin to PATH manually');
    }
    return ['User PATH'];
  }

  // macOS / Linux — update each shell config file
  const block = `\n${PATH_MARKER}\n${PATH_LINE}\n`;
  const updated = [];

  let configs = SHELL_CONFIGS.filter(existsSync);
  // No config yet: create one for the login shell (fish gets its own below).
  if (configs.length === 0 && !(process.env.SHELL || '').endsWith('/fish')) configs = [defaultShellConfig()];

  configs.forEach(file => {
    // Strip any existing tfv PATH block
    const content = existsSync(file) ? readFileSync(file, 'utf-8').replace(PATH_BLOCK_RE, '') : '';

    // Append at the very end so it always runs last and wins
    writeFileSync(file, content.trimEnd() + block);
    updated.push(file);
  });

  if (usesFish()) {
    mkdirSync(dirname(FISH_CONF), { recursive: true });
    writeFileSync(FISH_CONF, FISH_BLOCK);
    updated.push(FISH_CONF);
  }

  return updated;
};

module.exports = {
  TFV_HOME,
  SHELL_CONFIGS,
  PATH_MARKER,
  FISH_CONF,
  getPaths,
  getProviderStore,
  getBinTarget,
  getVersionFile,
  normalizeProvider,
  getCliName,
  getVersionArgs,
  providerFlag,
  PROVIDER_NAMES,
  emptyActive,
  initDirs,
  checkPathConflict,
  fixPathConflict,
};
