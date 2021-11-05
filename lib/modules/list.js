const fs = require('fs');
const {join} = require('path');
const {fetchAllVersions} = require('./available')

exports.list = async (installed = true, all) => {
  try {
    let versions;

    const result = (message, v) => {
      console.log(message + '\n');
      console.log(v.join('\n'));
    }

    if (all) {
      versions = await fetchAllVersions();

      return result('List of all available terraform versions', versions)
    }

    if (installed) {
      const store = join(__dirname, '../..', 'store');
      versions = fs.readdirSync(store).map(v => v.replace('.exe', ''));

      return result('Terraform versions managed by tfversion', versions);
    }
  } catch ({message}) {
    console.log(message)
  }
}
