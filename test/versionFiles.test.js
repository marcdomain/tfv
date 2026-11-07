const fs = require('fs');
const os = require('os');
const { join } = require('path');
const { findVersionFile } = require('../lib/utils/versionFiles');

let dir;
const write = (name, content) => fs.writeFileSync(join(dir, name), content);

beforeEach(() => { dir = fs.mkdtempSync(join(os.tmpdir(), 'tfv-vf-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('terraform', () => {
  test('.terraform-version', () => {
    write('.terraform-version', '1.9.0\n');
    expect(findVersionFile(dir)).toEqual({ file: '.terraform-version', version: '1.9.0' });
  });

  test('skips comments and blank lines, handles CRLF', () => {
    write('.terraform-version', '# pinned\r\n\r\n1.9.0\r\n');
    expect(findVersionFile(dir).version).toBe('1.9.0');
  });

  test('.tfswitchrc', () => {
    write('.tfswitchrc', '1.6.0');
    expect(findVersionFile(dir)).toEqual({ file: '.tfswitchrc', version: '1.6.0' });
  });

  test('.tfswitch.toml', () => {
    write('.tfswitch.toml', 'bin = "~/bin/terraform"\nversion = "1.5.7"\n');
    expect(findVersionFile(dir)).toEqual({ file: '.tfswitch.toml', version: '1.5.7' });
  });

  test('.tool-versions picks the terraform line, first version wins', () => {
    write('.tool-versions', 'nodejs 20.1.0\nterraform 1.7.0 1.6.0 # main\nopentofu 1.8.0\n');
    expect(findVersionFile(dir)).toEqual({ file: '.tool-versions', version: '1.7.0' });
  });

  test('.terraform-version wins over .tool-versions', () => {
    write('.tool-versions', 'terraform 1.7.0\n');
    write('.terraform-version', '1.9.0\n');
    expect(findVersionFile(dir).file).toBe('.terraform-version');
  });

  test('ignores OpenTofu files', () => {
    write('.opentofu-version', '1.8.0');
    expect(findVersionFile(dir)).toBeNull();
  });

  test('null when nothing is pinned', () => {
    write('.tool-versions', 'nodejs 20.1.0\n');
    write('.terraform-version', '\n# empty\n');
    expect(findVersionFile(dir)).toBeNull();
  });
});

describe('opentofu', () => {
  test('.opentofu-version wins over .tofu-version', () => {
    write('.tofu-version', '1.7.0');
    write('.opentofu-version', '1.8.0');
    expect(findVersionFile(dir, 'opentofu')).toEqual({ file: '.opentofu-version', version: '1.8.0' });
  });

  test('.tool-versions accepts opentofu and tofu', () => {
    write('.tool-versions', 'terraform 1.9.0\ntofu 1.8.2\n');
    expect(findVersionFile(dir, 'opentofu')).toEqual({ file: '.tool-versions', version: '1.8.2' });
  });

  test('falls back to .terraform-version unless strict', () => {
    write('.terraform-version', '1.9.0');
    expect(findVersionFile(dir, 'opentofu')).toEqual({ file: '.terraform-version', version: '1.9.0' });
    expect(findVersionFile(dir, 'opentofu', { strict: true })).toBeNull();
  });
});
