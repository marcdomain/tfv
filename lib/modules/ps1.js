const {spawnSync} = require("child_process");
const {P_END, P_ERROR} = require('../utils/colors');

exports.setWindowsTerraform = async () => {
  const getSystemEnv = spawnSync(
    "powershell",
    ["(Get-ItemProperty -Path 'Registry::HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Control\\Session Manager\\Environment' -Name PATH).path"],
    {stdio: 'pipe'}
  );

  if (!getSystemEnv || getSystemEnv.status === 1) {
    console.log(`${P_ERROR}Error ocurred while fetching windows environment${P_END}`);
    process.exit(1);
  }

  const systemEnv = getSystemEnv.stdout.toString().trim();

  const terraformPath = 'C:\\terraform';
  const getTerraformEnv = systemEnv.split(';').find(v => v === terraformPath);

  if (!getTerraformEnv) {
    const newSystemEnv = `${terraformPath};${systemEnv}`;

    const updateEnv = spawnSync(
      "powershell",
      [
        "-command",
        `start-process powershell -verb runas -argumentlist "Set-ItemProperty -Path 'Registry::HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Control\\Session Manager\\Environment' -Name PATH -Value '${newSystemEnv}'"`
      ],
      {stdio: 'pipe'}
    );

    if (!updateEnv || updateEnv.status === 1) {
      console.log(`${P_ERROR}Error ocurred while setting windows Environment${P_END}`);
      process.exit(1);
    }
  }
}
