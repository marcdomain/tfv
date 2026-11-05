const { join } = require('path');
const { platform } = require('os');
const { existsSync, openSync, writeSync, closeSync, writeFileSync } = require('fs');
const { TFV_HOME } = require('./paths');
const { P_END, P_OK, P_WARN, P_INFO } = require('./colors');

// Created once the user has seen the welcome banner.
const WELCOME_MARKER = join(TFV_HOME, '.welcomed');

const welcomeText = () => {
  const restart = platform() === 'win32'
    ? 'Restart your terminal so the PATH change takes effect.'
    : 'Restart your terminal (or open a new tab) so the PATH change takes effect.';
  return `
         _        ________        __
       _| |__   / _____|\\ \\      / /
      |_  ___\\ | |___    \\ \\    / /
        | |    |  ___|    \\ \\  / /
        | |___ | |         \\ \\/ /
        \\______\\_|          \\__/

        ${P_OK}Happy terraforming!${P_END} 😍🥂
    ---------------------------------

${P_INFO}tfv store: ${TFV_HOME}${P_END}
${P_WARN}${restart}${P_END}

${P_OK}Run ${P_END}${P_INFO}tfv install latest${P_END}${P_OK} to get started.${P_END}
`;
};

const hasBeenWelcomed = () => existsSync(WELCOME_MARKER);

const markWelcomed = () => {
  try {
    if (existsSync(TFV_HOME)) writeFileSync(WELCOME_MARKER, '');
  } catch {}
};

// npm 7+ hides install script output, so the postinstall writes straight to
// the terminal. Returns true if the user could see it.
const writeToTerminal = (text) => {
  if (process.stdout.isTTY) {
    process.stdout.write(text);
    return true;
  }
  if (platform() === 'win32') return false;
  try {
    const fd = openSync('/dev/tty', 'w');
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false; // no terminal (CI, Docker build, ...)
  }
};

module.exports = { WELCOME_MARKER, welcomeText, hasBeenWelcomed, markWelcomed, writeToTerminal };
