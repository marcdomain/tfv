const fs = require('fs');
const {P_END, P_OK, P_ERROR} = require('./colors');

exports.checkStore = (store) => {
  if (!fs.existsSync(store)) {
    console.log(`${P_ERROR}You're yet to install terraform with tfv${P_END}`);
    console.log(`For guidance, run ${P_OK}tfv -h${P_END}`);
    process.exit(1);
  }
}
