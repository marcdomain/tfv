// postinstall. Package managers don't always run it (pnpm 10, Bun, Yarn
// Berry and --ignore-scripts skip it), so index.js runs the same setup, and
// shows the banner, on first use. Nothing here may fail the install.

const { isSudo, runSetup } = require('./setup');
const { welcomeText, markWelcomed, writeToTerminal } = require('./banner');
const { P_END, P_INFO } = require('./colors');

try {
  // `sudo npm i -g`: setup as root would leave root-owned files in ~/.teriac,
  // so it waits for the first normal run.
  if (!isSudo()) runSetup();

  const text = isSudo()
    ? welcomeText() + `${P_INFO}Installed with sudo: teriac finishes setup the first time you run it.${P_END}\n`
    : welcomeText();

  if (writeToTerminal(text)) {
    if (!isSudo()) markWelcomed();
  } else {
    console.log(text); // still lands in logs; the banner shows again on first run
  }
} catch (err) {
  console.log(`postInstall error (non-fatal, teriac will retry on first run): ${err.message}`);
}
