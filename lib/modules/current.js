const { existsSync, readFileSync } = require('fs');
const { spawnSync } = require('child_process');
const { normalizeProvider, getCliName, getPaths, getBinTarget, checkPathConflict } = require('../utils/paths');
const { P_END, P_OK, P_INFO, P_WARN, P_ERROR } = require('../utils/colors');

exports.current = async (providerArg = 'terraform') => {
  try {
    const provider = normalizeProvider(providerArg);
    const paths = getPaths();

    let activeVersion = null;
    if (existsSync(paths.active)) {
      const active = JSON.parse(readFileSync(paths.active, 'utf-8'));
      activeVersion = active[provider];
    }

    if (!activeVersion) {
      console.log(`${P_WARN}No active ${provider} version set.${P_END}`);
      console.log(`Run: ${P_OK}tfv use <version>${providerArg === 'terraform' ? '' : ` --provider ${providerArg}`}${P_END}`);
      return;
    }

    // Confirm binary is present and get its real version output
    const binary = getBinTarget(provider);
    const cliName = getCliName(provider);

    console.log(`${P_INFO}Active ${provider} version: ${P_OK}${activeVersion}${P_END}`);
    console.log(`${P_INFO}Binary: ${binary}${P_END}`);

    if (existsSync(binary)) {
      const result = spawnSync(binary, ['version'], { stdio: 'pipe', encoding: 'utf-8' });
      if (result.stdout) {
        const firstLine = result.stdout.split('\n')[0];
        console.log(`${P_INFO}Reported: ${firstLine}${P_END}`);
      }
    } else {
      console.log(`${P_WARN}Binary not found at ${binary}. Re-run: tfv use ${activeVersion}${providerArg === 'terraform' ? '' : ` --provider ${providerArg}`}${P_END}`);
    }

    // Check if a conflicting installation shadows tfv's binary
    const conflict = checkPathConflict(provider);
    if (conflict.ok) {
      console.log(`${P_OK}PATH OK — '${cliName}' resolves to tfv-managed binary${P_END}`);
    } else {
      console.log(`${P_WARN}PATH CONFLICT — '${cliName}' resolves to: ${conflict.resolved}${P_END}`);
      console.log(`${P_WARN}Expected:                               ${conflict.expected}${P_END}`);
      console.log(`${P_INFO}Run ${P_OK}tfv upgrade${P_END}${P_INFO} to re-anchor the PATH automatically.${P_END}`);
    }
  } catch (err) {
    console.log(`${P_ERROR}Error: ${err.message}${P_END}`);
  }
};
