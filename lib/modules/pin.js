const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { normalizeProvider, getPaths } = require('../utils/paths');
const { P_END, P_OK, P_WARN, P_ERROR } = require('../utils/colors');

exports.pin = async (version, providerArg = 'terraform') => {
  try {
    const provider = normalizeProvider(providerArg);
    let pinVersion = version;

    if (!pinVersion || pinVersion === 'current') {
      const paths = getPaths();
      if (!existsSync(paths.active)) {
        console.log(`${P_ERROR}No active ${provider} version found.${P_END}`);
        console.log(`Run: ${P_OK}tfv use <version>${providerArg === 'terraform' ? '' : ` --provider ${providerArg}`}${P_END}`);
        process.exit(1);
      }
      const active = JSON.parse(readFileSync(paths.active, 'utf-8'));
      pinVersion = active[provider];
      if (!pinVersion) {
        console.log(`${P_ERROR}No active ${provider} version set.${P_END}`);
        console.log(`Run: ${P_OK}tfv use <version>${providerArg === 'terraform' ? '' : ` --provider ${providerArg}`}${P_END}`);
        process.exit(1);
      }
    }

    const targetFile = join(process.cwd(), '.terraform-version');
    writeFileSync(targetFile, pinVersion);

    console.log(`${P_OK}Pinned ${provider} ${pinVersion} to .terraform-version${P_END}`);
    console.log(`${P_OK}Other team members can run: tfv auto-switch${P_END}`);
  } catch (err) {
    console.log(`${P_ERROR}Error: ${err.message}${P_END}`);
  }
};
