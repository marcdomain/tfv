const fs = require('fs');
const os = require('os');
const { join } = require('path');

const VERSIONS = ['1.10.0', '1.9.8', '1.9.2', '1.8.5', '1.5.7'];

// Loads tfv/core with TFV_HOME pointed at a temp dir and the remote
// version list stubbed, so nothing touches ~/.tfv or the network.
const loadCore = (home) => {
  let core;
  const previous = process.env.TFV_HOME;
  process.env.TFV_HOME = home;
  jest.isolateModules(() => {
    jest.doMock('../lib/modules/remote', () => ({
      fetchAllVersions: jest.fn(async () => VERSIONS),
      fetchUrl: jest.fn(async () => { throw new Error('network disabled in tests'); }),
    }));
    core = require('../lib/core');
  });
  if (previous === undefined) delete process.env.TFV_HOME; else process.env.TFV_HOME = previous;
  return core;
};

let home;
let project;
let core;

beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tfv-core-home-'));
  project = fs.mkdtempSync(join(os.tmpdir(), 'tfv-core-proj-'));
  core = loadCore(home);
});

afterEach(() => {
  jest.dontMock('../lib/modules/remote');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

const write = (file, content) => fs.writeFileSync(join(project, file), content);

describe('findPinnedVersion', () => {
  test('returns null when nothing is pinned', () => {
    expect(core.findPinnedVersion(project, 'terraform')).toBeNull();
  });

  test('version file wins over required_version', () => {
    write('.terraform-version', '1.9.2\n');
    write('main.tf', 'terraform {\n  required_version = ">= 1.5"\n}\n');
    expect(core.findPinnedVersion(project, 'terraform')).toEqual({ file: '.terraform-version', version: '1.9.2' });
  });

  test('reads required_version from .tf files', () => {
    write('versions.tf', 'terraform {\n  required_version = "~> 1.9"\n}\n');
    expect(core.findPinnedVersion(project, 'tf')).toEqual({ file: 'versions.tf', version: '~> 1.9' });
  });

  test('reads terraform.tfstate', () => {
    write('terraform.tfstate', JSON.stringify({ terraform_version: '1.8.5' }));
    expect(core.findPinnedVersion(project, 'terraform')).toEqual({ file: 'terraform.tfstate', version: '1.8.5' });
  });

  test('strict mode only trusts version files', () => {
    write('main.tf', 'terraform {\n  required_version = "1.9.8"\n}\n');
    expect(core.findPinnedVersion(project, 'terraform', { strict: true })).toBeNull();
  });

  test('terragrunt reads terragrunt_version_constraint and stops there', () => {
    write('terragrunt.hcl', 'terragrunt_version_constraint = ">= 0.50"\n');
    expect(core.findPinnedVersion(project, 'tg')).toEqual({ file: 'terragrunt.hcl', version: '>= 0.50' });
    fs.rmSync(join(project, 'terragrunt.hcl'));
    write('main.tf', 'terraform {\n  required_version = "1.9.8"\n}\n');
    expect(core.findPinnedVersion(project, 'terragrunt')).toBeNull();
  });
});

describe('resolveExactVersion', () => {
  test('exact versions pass through without a lookup', async () => {
    expect(await core.resolveExactVersion('terraform', '1.2.3')).toBe('1.2.3');
    expect(await core.resolveExactVersion('terraform', 'v1.2.3')).toBe('1.2.3');
  });

  test('constraints resolve to the newest match', async () => {
    expect(await core.resolveExactVersion('terraform', '>= 1.5, < 1.10')).toBe('1.9.8');
    expect(await core.resolveExactVersion('terraform', '~> 1.8.0')).toBe('1.8.5');
  });

  test('a prefix resolves to the newest release in that series', async () => {
    expect(await core.resolveExactVersion('terraform', '1.9')).toBe('1.9.8');
  });

  test('throws NO_MATCH when nothing satisfies', async () => {
    await expect(core.resolveExactVersion('terraform', '>= 2.0')).rejects.toMatchObject({ code: core.CODES.NO_MATCH });
    await expect(core.resolveExactVersion('terraform', '1.1')).rejects.toMatchObject({ code: core.CODES.NO_MATCH });
  });
});

describe('ensureVersion', () => {
  test('throws NO_VERSION when nothing is pinned and there is no fallback', async () => {
    await expect(core.ensureVersion(project, 'terraform')).rejects.toMatchObject({ code: core.CODES.NO_VERSION });
  });

  test('returns an installed binary from TFV_HOME without downloading', async () => {
    const store = join(home, 'store', 'terraform');
    fs.mkdirSync(store, { recursive: true });
    const binName = process.platform === 'win32' ? '1.9.8.exe' : '1.9.8';
    fs.writeFileSync(join(store, binName), '');
    write('versions.tf', 'terraform {\n  required_version = "~> 1.9.0"\n}\n');

    const result = await core.ensureVersion(project, 'terraform');
    expect(result).toEqual({
      provider: 'terraform',
      version: '1.9.8',
      binary: join(store, binName),
      source: { file: 'versions.tf', version: '~> 1.9.0' },
    });
  });

  test('fallback is used when nothing is pinned', async () => {
    const store = join(home, 'store', 'opentofu');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(join(store, process.platform === 'win32' ? '1.10.0.exe' : '1.10.0'), '');
    const result = await core.ensureVersion(project, 'tofu', { fallback: '>= 0' });
    expect(result.version).toBe('1.10.0');
    expect(result.source).toBeNull();
  });
});

describe('installVersion', () => {
  test('unknown versions throw VERSION_NOT_FOUND', async () => {
    await expect(core.installVersion('terraform', '9.9.9')).rejects.toMatchObject({
      code: core.CODES.VERSION_NOT_FOUND,
      message: 'terraform 9.9.9 not found.',
    });
  });

  test('reports alreadyInstalled for versions in the store', async () => {
    const store = join(home, 'store', 'terraform');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(join(store, process.platform === 'win32' ? '1.9.8.exe' : '1.9.8'), '');
    const result = await core.installVersion('terraform', '1.9^');
    expect(result).toMatchObject({ provider: 'terraform', version: '1.9.8', alreadyInstalled: true });
  });
});

describe('findBinaryEntry', () => {
  const { findBinaryEntry } = require('../lib/core/install');
  const entry = (entryName, isDirectory = false) => ({ entryName, isDirectory });

  test('picks the binary, not LICENSE (OpenTofu zips list LICENSE first)', () => {
    const entries = [entry('CHANGELOG.md'), entry('LICENSE'), entry('README.md'), entry('tofu')];
    expect(findBinaryEntry(entries, 'opentofu').entryName).toBe('tofu');
  });

  test('terraform and Windows .exe', () => {
    expect(findBinaryEntry([entry('LICENSE.txt'), entry('terraform')], 'terraform').entryName).toBe('terraform');
    expect(findBinaryEntry([entry('LICENSE'), entry('tofu.exe')], 'opentofu').entryName).toBe('tofu.exe');
  });

  test('null when the binary is missing', () => {
    expect(findBinaryEntry([entry('LICENSE'), entry('README.md')], 'opentofu')).toBeNull();
  });
});
