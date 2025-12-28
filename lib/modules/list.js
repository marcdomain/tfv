const fs = require('fs');
const {join} = require('path');
const {spawnSync} = require('child_process')
const {fetchAllVersions} = require('./remote');
const {formatVersions} = require('../utils/formatVersions');
const {P_END, P_OK} = require('../utils/colors');
const {checkStore} = require('../utils/store');

const MAX_COLUMNS_PER_TABLE = 6;

/**
 * Groups versions by their major.minor prefix
 */
const groupVersionsByRelease = (versions) => {
  const groups = {};

  versions.forEach(version => {
    const parts = version.split('.');
    if (parts.length >= 2) {
      const majorMinor = `${parts[0]}.${parts[1]}`;
      if (!groups[majorMinor]) {
        groups[majorMinor] = [];
      }
      groups[majorMinor].push(version);
    }
  });

  return groups;
};

/**
 * Displays versions in table format with first version of each release as column header
 * Breaks into multiple tables if columns exceed MAX_COLUMNS_PER_TABLE
 */
const displayVersionTable = (versions) => {
  const groups = groupVersionsByRelease(versions);

  // Sort release groups by version (descending)
  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const [aMajor, aMinor] = a.split('.').map(Number);
    const [bMajor, bMinor] = b.split('.').map(Number);
    if (bMajor !== aMajor) return bMajor - aMajor;
    return bMinor - aMinor;
  });

  // Sort versions within each group (descending)
  sortedKeys.forEach(key => {
    groups[key].sort((a, b) => {
      const aParts = a.split('.').map(n => parseInt(n) || 0);
      const bParts = b.split('.').map(n => parseInt(n) || 0);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aVal = aParts[i] || 0;
        const bVal = bParts[i] || 0;
        if (bVal !== aVal) return bVal - aVal;
      }
      return 0;
    });
  });

  // Split into chunks of MAX_COLUMNS_PER_TABLE
  const chunks = [];
  for (let i = 0; i < sortedKeys.length; i += MAX_COLUMNS_PER_TABLE) {
    chunks.push(sortedKeys.slice(i, i + MAX_COLUMNS_PER_TABLE));
  }

  // Display each chunk as a separate table
  chunks.forEach((chunkKeys, chunkIndex) => {
    // Find max rows needed for this chunk
    const maxRows = Math.max(...chunkKeys.map(key => groups[key].length));

    // Build table data
    const tableData = [];
    for (let row = 0; row < maxRows; row++) {
      const rowObj = {};
      chunkKeys.forEach(key => {
        // Use major.minor.x format as header (e.g., "1.5.x")
        const header = `${key}.x`;
        const value = groups[key][row] || '';
        rowObj[header] = value;
      });
      tableData.push(rowObj);
    }

    if (chunks.length > 1) {
      console.log(`\n${P_OK}Table ${chunkIndex + 1} of ${chunks.length}${P_END}`);
    }
    console.table(tableData);
  });
};

exports.list = async (local, remote) => {
  try {
    let versions;

    if (remote) {
      const data = await fetchAllVersions();
      versions = formatVersions(data);

      console.log(`${P_OK}List of all available terraform versions${P_END}\n`);
      return displayVersionTable(versions);
    }

    if (local) {
      const store = join(__dirname, '../..', 'store');

      checkStore(store);

      const tfVersion = spawnSync('terraform', ['version'], {stdio: 'pipe', encoding: 'utf-8'});
      const pattern = /v\d+\.\d+\.\d+/;
      const versionOutput = tfVersion.stdout.match(pattern);

      const archMap = `${store}/arch.json`;
      const archStore = fs.readFileSync(`${archMap}`, 'utf8');
      const parseArchFile = JSON.parse(archStore);
      const installedVersions = [];

      versions = fs.readdirSync(store).forEach(f => {
        if (f !== 'arch.json') {
          const versionNumber = f.replace('.exe', '');
          const vnObj = {};

          vnObj['Terraform Version'] = versionNumber;

          if (versionOutput && versionNumber === versionOutput[0].replace('v', '')) {
            vnObj['System Arch'] = `${parseArchFile[versionNumber]} 🚀`;
          }
          else vnObj['System Arch'] = parseArchFile[versionNumber];
          installedVersions.push(vnObj);
        }
      });

      console.log(`${P_OK}Terraform versions installed by tfv${P_END}`);
      return console.table(installedVersions);
    }
  } catch ({message}) {
    console.log(message)
  }
}
