const fs = require('fs');
const {join} = require('path');
const {fetchAllVersions} = require('./remote')

exports.list = async (local = true, remote) => {
  try {
    let versions;

    const result = (message, v) => {
      console.log(message + '\n');
      console.log(v.join('\n'));
    }

    if (remote) {
      versions = await fetchAllVersions();

      return result('List of all available terraform versions', versions)
    }

    if (local) {
      const store = join(__dirname, '../..', 'store');
      versions = fs.readdirSync(store).map(v => v.replace('.exe', ''));

      return result('Terraform versions managed by tfv', versions);
    }
  } catch ({message}) {
    console.log(message)
  }
}
