const { existsSync, readdirSync, unlinkSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const readline = require('readline');
const { normalizeProvider, getProviderStore, getVersionFile, getPaths } = require('../utils/paths');
const { P_END, P_OK, P_ERROR, P_WARN, P_INFO } = require('../utils/colors');

const sortVersionsDesc = (versions) => versions.sort((a, b) => {
  const ap = a.split('.').map(n => parseInt(n, 10) || 0);
  const bp = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (bp[i] || 0) - (ap[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
});

const confirm = (question) => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
});

exports.prune = async (providerArg = 'terraform', keep = 0, yes = false) => {
  try {
    const provider = normalizeProvider(providerArg);
    const store = getProviderStore(provider);

    if (!existsSync(store)) {
      console.log(`${P_ERROR}No store found for ${provider}.${P_END}`);
      process.exit(1);
    }

    const archFile = join(store, 'arch.json');
    const archMap = existsSync(archFile) ? JSON.parse(readFileSync(archFile, 'utf-8')) : {};

    const paths = getPaths();
    let activeVersion = null;
    if (existsSync(paths.active)) {
      const active = JSON.parse(readFileSync(paths.active, 'utf-8'));
      activeVersion = active[provider];
    }

    const installed = sortVersionsDesc(
      readdirSync(store)
        .filter(f => f !== 'arch.json')
        .map(f => f.replace(/\.exe$/, ''))
    );

    if (installed.length === 0) {
      console.log(`${P_WARN}No ${provider} versions installed.${P_END}`);
      return;
    }

    // Build the keep set: active version is always kept; top N by semver if --keep N
    const keepSet = new Set();
    if (activeVersion) keepSet.add(activeVersion);
    if (keep > 0) installed.slice(0, keep).forEach(v => keepSet.add(v));

    const toRemove = installed.filter(v => !keepSet.has(v));

    if (toRemove.length === 0) {
      console.log(`${P_OK}Nothing to prune for ${provider}.${P_END}`);
      if (activeVersion) console.log(`${P_INFO}Active version ${activeVersion} is kept.${P_END}`);
      return;
    }

    console.log(`${P_INFO}Versions to remove (${provider}):${P_END}`);
    toRemove.forEach(v => console.log(`  ${P_WARN}${v}${P_END}`));
    console.log();
    if (activeVersion) console.log(`${P_OK}Keeping (active): ${activeVersion}${P_END}`);
    if (keep > 0) {
      const kept = installed.filter(v => keepSet.has(v) && v !== activeVersion);
      if (kept.length) console.log(`${P_OK}Keeping (--keep ${keep}): ${kept.join(', ')}${P_END}`);
    }

    if (!yes) {
      const ans = await confirm(`\nRemove ${toRemove.length} version(s)? [y/N] `);
      if (ans !== 'y' && ans !== 'yes') {
        console.log(`${P_WARN}Aborted.${P_END}`);
        return;
      }
    }

    console.log();
    toRemove.forEach(v => {
      const file = getVersionFile(provider, v);
      if (existsSync(file)) {
        unlinkSync(file);
        delete archMap[v];
        console.log(`${P_OK}Removed ${provider} ${v}${P_END}`);
      }
    });

    writeFileSync(archFile, JSON.stringify(archMap, null, 2));
    console.log(`\n${P_OK}Done. Pruned ${toRemove.length} version(s).${P_END}`);

  } catch (err) {
    console.log(`${P_ERROR}Error: ${err.message}${P_END}`);
    process.exit(1);
  }
};
