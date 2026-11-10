const { join } = require('path');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const { HOME_DIR, initDirs, fixPathConflict, displayHome } = require('./paths');
const { version } = require('../../package.json');

// Records which teriac version last finished setup. A missing or stale marker
// means setup still has to run (first install, or an upgrade).
const SETUP_MARKER = join(HOME_DIR, '.setup');

// Under sudo, setup would leave root-owned files in the user's ~/.teriac, so it
// waits for a normal run.
const isSudo = () =>
  typeof process.getuid === 'function' && process.getuid() === 0 && !!process.env.SUDO_USER;

const isSetupDone = () => {
  try {
    return readFileSync(SETUP_MARKER, 'utf-8').trim() === version
      && existsSync(join(HOME_DIR, 'bin'));
  } catch {
    return false;
  }
};

// Creates ~/.teriac and puts ~/.teriac/bin on PATH. Returns the files it updated.
const runSetup = () => {
  initDirs();
  const updated = fixPathConflict();
  writeFileSync(SETUP_MARKER, `${version}\n`);
  return updated;
};

// Called on every `teriac` run: sets up on first run and after upgrades (teriac has
// no install script). Never throws, and logs to stderr so piped or eval'd output stays clean.
const ensureSetup = () => {
  if (isSudo()) return;
  const { welcomeText, hasBeenWelcomed, markWelcomed } = require('./banner');

  let updated = [];
  if (!isSetupDone()) {
    try {
      updated = runSetup();
    } catch (err) {
      console.error(`teriac: setup failed (${err.message}). Run \`teriac doctor\` for help.`);
      return;
    }
  }

  // Show the banner once, in a real terminal only.
  if (!hasBeenWelcomed() && process.stderr.isTTY) {
    process.stderr.write(welcomeText() + '\n');
    markWelcomed();
  } else if (updated.length) {
    console.error(`teriac: added ${displayHome()}/bin to PATH (${updated.join(', ')}). Restart your terminal to use it.`);
  }
};

module.exports = { SETUP_MARKER, isSudo, isSetupDone, runSetup, ensureSetup };
