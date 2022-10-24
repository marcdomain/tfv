const os = require('os')
const fs = require('fs');
const {join} = require('path');
const {P_END, P_OK, P_ERROR} = require('../utils/colors');

exports.remove = async (version) => {
  try {
    const store = join(__dirname, '../..', 'store');
    const tfVersion = os.platform() === 'win32' ? `${version}.exe` : version;
    const file = `${store}/${tfVersion}`;

    if (fs.existsSync(`${file}`)) {
      fs.unlinkSync(file);
      if (!fs.readdirSync(store).length) fs.rmdirSync(store);
      return console.log(`${P_OK}Terraform ${version} deleted from tfv store${P_END}`);
    } else {
      return console.log(`${P_ERROR}Terraform ${version} does not exist in tfv store${P_END}`);
    }
  } catch ({message}) {
    console.log('ERROR:', message)
  }
}
