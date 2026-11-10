const { join } = require('path');
const { platform } = require('os');
const { existsSync, writeFileSync } = require('fs');
const { HOME_DIR } = require('./paths');
const { P_END, P_OK, P_WARN, P_INFO } = require('./colors');

// Created once the user has seen the welcome banner.
const WELCOME_MARKER = join(HOME_DIR, '.welcomed');

// String.raw, so the art reads in the source exactly as it prints.
const ART = String.raw`
       _                _
      | |_   ___  _ __ (_)  __ _   ___
      | __| / _ \| '__|| | / _' | / __|
      | |_ |  __/| |   | || (_| || (__
       \__| \___||_|   |_| \__,_| \___|`;

const welcomeText = () => {
  const restart = platform() === 'win32'
    ? 'Restart your terminal so the PATH change takes effect.'
    : 'Restart your terminal (or open a new tab) so the PATH change takes effect.';
  return `${ART}

          ${P_OK}Happy terraforming!${P_END} 😍🥂
      ---------------------------------
      ☕ ${P_INFO}https://buymeacoffee.com/marcdomain${P_END}

${P_INFO}teriac store: ${HOME_DIR}${P_END}
${P_WARN}${restart}${P_END}

${P_OK}Run ${P_END}${P_INFO}teriac install latest${P_END}${P_OK} to get started.${P_END}
`;
};

const hasBeenWelcomed = () => existsSync(WELCOME_MARKER);

const markWelcomed = () => {
  try {
    if (existsSync(HOME_DIR)) writeFileSync(WELCOME_MARKER, '');
  } catch {}
};

module.exports = { WELCOME_MARKER, welcomeText, hasBeenWelcomed, markWelcomed };
