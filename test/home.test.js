// Where teriac keeps its files, and the PATH block it writes to shell configs.
// Pure functions only: nothing here reads or writes real home folders or shell configs.
const { join } = require('path');
const { resolveHome, shellHome, displayHome, windowsHome, stripPathBlocks, PATH_MARKER, PATH_LINE } = require('../lib/utils/paths');

const HOME = '/home/ada';

describe('resolveHome', () => {
  test('~/.teriac by default', () => {
    expect(resolveHome({ env: {}, home: HOME })).toBe(join(HOME, '.teriac'));
  });
  test('TERIAC_HOME overrides it', () => {
    expect(resolveHome({ env: { TERIAC_HOME: '/data/teriac' }, home: HOME })).toBe('/data/teriac');
  });
});

describe('the folder as shells and messages see it', () => {
  test('under the home folder', () => {
    expect(shellHome(join(HOME, '.teriac'), HOME)).toBe('$HOME/.teriac');
    expect(displayHome(join(HOME, '.teriac'), HOME)).toBe('~/.teriac');
    expect(windowsHome(join(HOME, '.teriac'), HOME)).toBe('.teriac');
  });
  test('a folder outside home is used as is', () => {
    expect(shellHome('/data/teriac', HOME)).toBe('/data/teriac');
    expect(displayHome('/data/teriac', HOME)).toBe('/data/teriac');
  });
});

describe('shell config PATH block: replaced, never duplicated', () => {
  const user = 'alias ll="ls -la"\nexport EDITOR=vim\n';
  test('removes our block', () => {
    expect(stripPathBlocks(`${user}\n${PATH_MARKER}\n${PATH_LINE}\n`).trim()).toBe(user.trim());
  });
  test('leaves everything else alone, including other tools\' PATH lines', () => {
    const other = `${user}# tfenv\nexport PATH="$HOME/.tfenv/bin:$PATH"\nexport PATH="$HOME/.cargo/bin:$PATH"\n`;
    expect(stripPathBlocks(other)).toBe(other);
  });
});
