const fs = require('fs');
const os = require('os');
const { join } = require('path');

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('plugin-cache', () => {
  let home;
  let log;
  const { pluginCache } = require('../lib/modules/pluginCache');
  const rc = (name) => join(home, name);
  const read = (name) => fs.readFileSync(rc(name), 'utf-8');

  let homeSpy;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'tfv-pc-'));
    // Jest doesn't pass a changed HOME through to os.homedir(), so stub it.
    homeSpy = jest.spyOn(os, 'homedir').mockReturnValue(home);
    // Never touch the real home directory.
    if (os.homedir() !== home) throw new Error('homedir stub not active');
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    homeSpy.mockRestore();
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('on creates the cache dir and ~/.terraformrc, but not ~/.tofurc', () => {
    pluginCache('on');
    expect(fs.existsSync(join(home, '.terraform.d', 'plugin-cache'))).toBe(true);
    expect(read('.terraformrc')).toMatch(/^# tfv plugin cache\nplugin_cache_dir = ".*plugin-cache"\n$/);
    expect(fs.existsSync(rc('.tofurc'))).toBe(false);
  });

  test('on keeps existing config and is idempotent', () => {
    fs.writeFileSync(rc('.terraformrc'), 'credentials "x" {\n  token = "t"\n}\n');
    pluginCache('on');
    pluginCache('on');
    const content = read('.terraformrc');
    expect(content.startsWith('credentials "x" {')).toBe(true);
    expect(content.match(/plugin_cache_dir/g)).toHaveLength(1);
  });

  test('on updates an existing ~/.tofurc', () => {
    fs.writeFileSync(rc('.tofurc'), 'provider_installation {}\n');
    pluginCache('on');
    expect(read('.tofurc')).toContain('plugin_cache_dir');
  });

  test('never overrides a plugin_cache_dir the user set', () => {
    fs.writeFileSync(rc('.terraformrc'), 'plugin_cache_dir = "/opt/cache"\n');
    pluginCache('on');
    pluginCache('off');
    expect(read('.terraformrc')).toBe('plugin_cache_dir = "/opt/cache"\n');
  });

  test('off removes only what tfv added', () => {
    fs.writeFileSync(rc('.terraformrc'), 'credentials "x" {}\n');
    pluginCache('on');
    pluginCache('off');
    expect(read('.terraformrc')).toBe('credentials "x" {}\n');
  });
});
