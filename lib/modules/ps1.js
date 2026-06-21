const { spawnSync } = require('child_process');
const { join } = require('path');
const { homedir } = require('os');
const { P_END, P_ERROR, P_WARN, P_OK } = require('../utils/colors');
const { TFV_HOME } = require('../utils/paths');

const BIN_DIR = join(TFV_HOME, 'bin');

/**
 * Ensures ~/.tfv/bin is in the Windows User PATH (no admin required).
 * Uses HKCU via [Environment]::SetEnvironmentVariable with "User" scope.
 */
exports.ensureWindowsPath = () => {
  const getUserPath = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command',
      '[Environment]::GetEnvironmentVariable("PATH", "User")'],
    { stdio: 'pipe', encoding: 'utf-8' }
  );

  if (!getUserPath || getUserPath.status !== 0) {
    console.log(`${P_WARN}Could not read Windows User PATH. Please add manually: ${BIN_DIR}${P_END}`);
    return;
  }

  const currentPath = (getUserPath.stdout || '').trim();
  const pathEntries = currentPath.split(';').map(p => p.trim()).filter(Boolean);

  if (pathEntries.includes(BIN_DIR)) return; // Already in PATH

  const newPath = `${BIN_DIR};${currentPath}`;
  const updateEnv = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command',
      `[Environment]::SetEnvironmentVariable("PATH", "${newPath}", "User")`],
    { stdio: 'pipe' }
  );

  if (updateEnv && updateEnv.status === 0) {
    console.log(`${P_OK}Added ${BIN_DIR} to your User PATH.${P_END}`);
    console.log(`${P_WARN}Restart your terminal for the PATH change to take effect.${P_END}`);
  } else {
    console.log(`${P_ERROR}Could not update PATH automatically.${P_END}`);
    console.log(`${P_WARN}Please add manually to your User PATH: ${BIN_DIR}${P_END}`);
  }
};
