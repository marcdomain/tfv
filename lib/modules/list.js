const { existsSync, readdirSync, readFileSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');
const { fetchAllVersions } = require('./remote');
const { normalizeProvider, getProviderStore, getCliName, getPaths } = require('../utils/paths');
const { checkStore } = require('../utils/store');
const { P_END, P_OK, P_WARN } = require('../utils/colors');

const MAX_COLUMNS = 6;

const groupByRelease = (versions) => {
  const groups = {};
  versions.forEach(v => {
    const parts = v.split('.');
    if (parts.length >= 2) {
      const key = `${parts[0]}.${parts[1]}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(v);
    }
  });
  return groups;
};

const displayRemoteTable = (versions) => {
  const groups = groupByRelease(versions);
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const [aMaj, aMin] = a.split('.').map(Number);
    const [bMaj, bMin] = b.split('.').map(Number);
    return bMaj !== aMaj ? bMaj - aMaj : bMin - aMin;
  });

  const chunks = [];
  for (let i = 0; i < sortedKeys.length; i += MAX_COLUMNS) {
    chunks.push(sortedKeys.slice(i, i + MAX_COLUMNS));
  }

  chunks.forEach((chunkKeys, idx) => {
    const maxRows = Math.max(...chunkKeys.map(k => groups[k].length));
    const tableData = [];
    for (let row = 0; row < maxRows; row++) {
      const rowObj = {};
      chunkKeys.forEach(k => { rowObj[`${k}.x`] = groups[k][row] || ''; });
      tableData.push(rowObj);
    }
    if (chunks.length > 1) console.log(`\n${P_OK}Table ${idx + 1} of ${chunks.length}${P_END}`);
    console.table(tableData);
  });
};

exports.list = async (local, remote, providerArg = 'terraform') => {
  try {
    const provider = normalizeProvider(providerArg);
    const cliName = getCliName(provider);

    if (remote) {
      const versions = await fetchAllVersions(provider);
      console.log(`${P_OK}Available ${provider} versions (${versions.length} total)${P_END}\n`);
      return displayRemoteTable(versions);
    }

    // Default: local
    checkStore(provider);
    const store = getProviderStore(provider);

    // Get currently active version
    const paths = getPaths();
    let activeVersion = null;
    if (existsSync(paths.active)) {
      const active = JSON.parse(readFileSync(paths.active, 'utf-8'));
      activeVersion = active[provider];
    }

    const archFile = join(store, 'arch.json');
    const archMap = existsSync(archFile) ? JSON.parse(readFileSync(archFile, 'utf-8')) : {};

    const rows = readdirSync(store)
      .filter(f => f !== 'arch.json')
      .map(f => f.replace('.exe', ''))
      .sort((a, b) => {
        const aParts = a.split('.').map(n => parseInt(n, 10) || 0);
        const bParts = b.split('.').map(n => parseInt(n, 10) || 0);
        for (let i = 0; i < 3; i++) {
          const diff = (bParts[i] || 0) - (aParts[i] || 0);
          if (diff !== 0) return diff;
        }
        return 0;
      })
      .map(v => ({
        'Version': v === activeVersion ? `${v} 🚀` : v,
        'Arch': archMap[v] || 'unknown',
        'Status': v === activeVersion ? 'active' : '',
      }));

    console.log(`${P_OK}Installed ${provider} versions${P_END}`);
    console.table(rows);
  } catch (err) {
    console.log(err.message);
  }
};
