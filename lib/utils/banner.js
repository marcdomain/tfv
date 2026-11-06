const { join } = require('path');
const { platform } = require('os');
const { existsSync, openSync, writeSync, closeSync, writeFileSync, readFileSync, readlinkSync } = require('fs');
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
    ☕ ${P_INFO}https://buymeacoffee.com/marcdomain${P_END}

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

// Terminals the banner could be written to. /dev/tty works on macOS, but
// can be refused inside npm's script process (e.g. Termux on Android), so on
// Linux/Android we also look up the terminal npm or the shell is attached to.
const ttyCandidates = () => {
  const found = ['/dev/tty'];
  let pid = process.pid;
  for (let i = 0; i < 10 && pid > 1; i++) {
    for (const fd of [1, 2, 0]) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        if (/^\/dev\/(pts\/\d+|tty[\w.]*)$/.test(target)) found.push(target);
      } catch {}
    }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]); // parent pid
    } catch {
      break; // no /proc (macOS)
    }
  }
  return [...new Set(found)];
};

// npm 7+ hides install script output, so the postinstall writes straight to
// the terminal. Returns true if the user could see it.
const writeToTerminal = (text) => {
  if (process.stdout.isTTY) {
    process.stdout.write(text);
    return true;
  }
  if (platform() === 'win32') return false;
  for (const tty of ttyCandidates()) {
    try {
      const fd = openSync(tty, 'w');
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {}
  }
  return false; // no terminal (CI, Docker build, ...)
};

module.exports = { WELCOME_MARKER, welcomeText, hasBeenWelcomed, markWelcomed, writeToTerminal };
