const { platform } = require('os');
const { initDirs, getPaths, fixPathConflict } = require('./paths');
const { P_END, P_OK, P_WARN, P_INFO } = require('./colors');

const banner = `
         _        ________        __
       _| |__   / _____|\\ \\      / /
      |_  ___\\ | |___    \\ \\    / /
        | |    |  ___|    \\ \\  / /
        | |___ | |         \\ \\/ /
        \\______\\_|          \\__/

        ${P_OK}Happy terraforming!${P_END} 😍🥂
    ---------------------------------
`;

try {
  initDirs();
  console.log(banner);

  const { home } = getPaths();
  console.log(`${P_INFO}tfv store: ${home}${P_END}`);

  // Ensure ~/.tfv/bin is on PATH and positioned AFTER any system-level tool managers
  // (brew, apt, etc.) so tfv always takes precedence. Safe to re-run on upgrade.
  fixPathConflict();

  if (platform() !== 'win32') {
    console.log(`${P_OK}~/.tfv/bin added to PATH in your shell config files.${P_END}`);
    console.log(`${P_WARN}Restart your terminal or run: source ~/.zshrc${P_END}`);
  } else {
    console.log(`${P_OK}~/.tfv/bin added to your User PATH.${P_END}`);
    console.log(`${P_WARN}Restart your terminal for the change to take effect.${P_END}`);
  }

  console.log(`\n${P_OK}Run ${P_END}${P_INFO}tfv install latest${P_END}${P_OK} to get started.${P_END}\n`);
} catch (err) {
  console.log('postInstall error (non-fatal):', err.message);
}
