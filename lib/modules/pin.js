const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { normalizeProvider, getPaths, providerFlag } = require('../utils/paths');

// Each tool gets its own pin file, so pinning one never switches another.
const PIN_FILES = { terraform: '.terraform-version', opentofu: '.opentofu-version', terragrunt: '.terragrunt-version' };
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

    const pinFile = PIN_FILES[provider];
    writeFileSync(join(process.cwd(), pinFile), `${pinVersion}\n`);

    console.log(`${P_OK}Pinned ${provider} ${pinVersion} to ${pinFile}${P_END}`);
    console.log(`${P_OK}Other team members can run: tfv auto-switch${providerFlag(provider)}${P_END}`);
  } catch (err) {
    console.log(`${P_ERROR}Error: ${err.message}${P_END}`);
  }
};
