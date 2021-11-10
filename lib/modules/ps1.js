const {spawnSync} = require("child_process");

const result = spawnSync(
  "powershell",
  [
    "-command",
    "start-process powershell -verb runas -argumentlist \"echo '$($env:path);C:\\tfvers'; pause\""
  ],
  {stdio: 'pipe'}
);

if (!result || result.status === 1) {
  console.log('error ocurred!');
  process.exit(1);
}

console.log(result);
