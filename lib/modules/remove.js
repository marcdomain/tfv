const os = require('os')
const fs = require('fs');
const {join} = require('path');
const {P_END, P_OK, P_ERROR} = require('../utils/colors');

exports.remove = async (version) => {
  try {
    const store = join(__dirname, '../..', 'store');
    const arch = JSON.parse(fs.readFileSync(`${store}/arch.json`, 'utf-8'));

    version.forEach(v => {
      const tfVersion = os.platform() === 'win32' ? `${v}.exe` : v;
      const file = `${store}/${tfVersion}`;

      if (fs.existsSync(`${file}`)) {
        fs.unlinkSync(file);

        delete arch[v];

        return console.log(`${P_OK}Terraform ${v} deleted from tfv store${P_END}`);
      } else {
        return console.log(`${P_ERROR}Terraform ${v} does not exist in tfv store${P_END}`);
      }
    })

    fs.writeFileSync(`${store}/arch.json`, JSON.stringify(arch, null, 2));
  } catch ({message}) {
    console.log('ERROR:', message)
  }
}
