const fs = require('fs');
const {join} = require('path');
const {fetchAllVersions} = require('./remote');
const {P_END, P_OK, P_ERROR} = require('../utils/colors');

exports.list = async (local, remote) => {
  try {
    let versions;

    const result = (message, v) => {
      console.log(`${P_OK}${message}${P_END}` + '\n');
      console.log(v.join('\n'));
    }

    if (remote) {
      versions = await fetchAllVersions();

      return result('List of all available terraform versions', versions)
    }

    if (local) {
      const store = join(__dirname, '../..', 'store');

      if (!fs.existsSync(store)) {
        console.log(`${P_ERROR}You're yet to install terraform with tfv${P_END}`);
        return console.log(`For guidance, run ${P_OK}tfv -h${P_END}`);
      }

      versions = fs.readdirSync(store).map(v => v.replace('.exe', ''));

      return result('Terraform versions installed by tfv', versions);
    }
  } catch ({message}) {
    console.log(message)
  }
}
