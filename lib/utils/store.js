const { existsSync, readdirSync } = require('fs');
const { getProviderStore, initDirs } = require('./paths');
const { P_END, P_OK, P_ERROR } = require('./colors');

exports.checkStore = (provider = 'terraform') => {
  initDirs();
  const store = getProviderStore(provider);

  if (!existsSync(store)) {
    console.log(`${P_ERROR}Store not found for provider: ${provider}${P_END}`);
    console.log(`For guidance, run ${P_OK}tfv -h${P_END}`);
    process.exit(1);
  }

  const files = readdirSync(store).filter(f => f !== 'arch.json');
  if (files.length === 0) {
    console.log(`${P_ERROR}You're yet to install ${provider} with tfv${P_END}`);
    console.log(`For guidance, run ${P_OK}tfv -h${P_END}`);
    process.exit(1);
  }
};
