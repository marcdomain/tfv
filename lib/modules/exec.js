const { existsSync } = require('fs');
const { spawn } = require('child_process');
const { normalizeProvider, getCliName, getVersionFile } = require('../utils/paths');
const { P_END, P_OK, P_ERROR, P_WARN, P_INFO } = require('../utils/colors');

exports.exec = async (version, extraArgs = [], providerArg = 'terraform') => {
  try {
    const provider = normalizeProvider(providerArg);
    const cli = getCliName(provider);
    const binary = getVersionFile(provider, version);

    if (!existsSync(binary)) {
      console.log(`${P_ERROR}${provider} ${version} is not installed.${P_END}`);
      console.log(`Run: ${P_OK}tfv install ${version}${provider === 'opentofu' ? ' --provider tofu' : ''}${P_END}`);
      process.exit(1);
    }

    console.log(`${P_INFO}Using ${provider} ${version} (active version unchanged)${P_END}`);
    if (extraArgs.length > 0) {
      console.log(`${P_OK}Running: ${cli} ${extraArgs.join(' ')}${P_END}\n`);
    }

    const tf = spawn(binary, extraArgs, { stdio: 'inherit', cwd: process.cwd() });

    tf.on('error', (err) => {
      console.log(`${P_ERROR}Error executing ${cli} ${version}: ${err.message}${P_END}`);
      process.exit(1);
    });

    tf.on('close', code => process.exit(code ?? 0));

  } catch (err) {
    console.log(`${P_ERROR}Error: ${err.message}${P_END}`);
    process.exit(1);
  }
};
