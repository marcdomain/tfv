const { join } = require('path');
const { homedir } = require('os');
const {
  HOME_DIR,
  getPaths,
  normalizeProvider,
  getCliName,
  getVersionArgs,
  getProviderStore,
} = require('../lib/utils/paths');

describe('HOME_DIR', () => {
  test('is ~/.teriac, or TERIAC_HOME when set', () => {
    expect(HOME_DIR).toBe(process.env.TERIAC_HOME || join(homedir(), '.teriac'));
  });
});

describe('getPaths', () => {
  const paths = getPaths();

  test('bin is inside HOME_DIR', () => {
    expect(paths.bin).toBe(join(HOME_DIR, 'bin'));
  });

  test('store is inside HOME_DIR', () => {
    expect(paths.store).toBe(join(HOME_DIR, 'store'));
  });

  test('terraform store is correct', () => {
    expect(paths.terraform).toBe(join(HOME_DIR, 'store', 'terraform'));
  });

  test('opentofu store is correct', () => {
    expect(paths.opentofu).toBe(join(HOME_DIR, 'store', 'opentofu'));
  });

  test('active.json is in HOME_DIR', () => {
    expect(paths.active).toBe(join(HOME_DIR, 'active.json'));
  });
});

describe('normalizeProvider', () => {
  test('terraform → terraform', () => expect(normalizeProvider('terraform')).toBe('terraform'));
  test('tf → terraform', () => expect(normalizeProvider('tf')).toBe('terraform'));
  test('tofu → opentofu', () => expect(normalizeProvider('tofu')).toBe('opentofu'));
  test('opentofu → opentofu', () => expect(normalizeProvider('opentofu')).toBe('opentofu'));
  test('default (undefined) → terraform', () => expect(normalizeProvider()).toBe('terraform'));
  test('unknown → terraform', () => expect(normalizeProvider('unknown')).toBe('terraform'));
});

describe('getCliName', () => {
  test('terraform → terraform', () => expect(getCliName('terraform')).toBe('terraform'));
  test('tf → terraform', () => expect(getCliName('tf')).toBe('terraform'));
  test('tofu → tofu', () => expect(getCliName('tofu')).toBe('tofu'));
  test('opentofu → tofu', () => expect(getCliName('opentofu')).toBe('tofu'));
});

describe('getProviderStore', () => {
  test('returns terraform store by default', () => {
    expect(getProviderStore()).toBe(join(HOME_DIR, 'store', 'terraform'));
  });

  test('returns opentofu store for tofu alias', () => {
    expect(getProviderStore('tofu')).toBe(join(HOME_DIR, 'store', 'opentofu'));
  });

  test('returns opentofu store', () => {
    expect(getProviderStore('opentofu')).toBe(join(HOME_DIR, 'store', 'opentofu'));
  });
});

describe('terragrunt provider', () => {
  const { providerFlag, PROVIDER_NAMES, emptyActive } = require('../lib/utils/paths');

  test('aliases', () => {
    expect(normalizeProvider('terragrunt')).toBe('terragrunt');
    expect(normalizeProvider('tg')).toBe('terragrunt');
  });

  test('cli names', () => {
    expect(getCliName('tg')).toBe('terragrunt');
    expect(getCliName('tofu')).toBe('tofu');
    expect(getCliName('terraform')).toBe('terraform');
  });

  test('store path', () => {
    expect(getProviderStore('tg')).toBe(join(HOME_DIR, 'store', 'terragrunt'));
  });

  test('provider flag for hints', () => {
    expect(providerFlag('terraform')).toBe('');
    expect(providerFlag('opentofu')).toBe(' --provider tofu');
    expect(providerFlag('tg')).toBe(' --provider terragrunt');
  });

  test('active.json covers every provider', () => {
    expect(PROVIDER_NAMES).toEqual(['terraform', 'opentofu', 'terragrunt']);
    expect(emptyActive()).toEqual({ terraform: null, opentofu: null, terragrunt: null });
  });
});

describe('getVersionArgs', () => {
  test('terraform uses version', () => expect(getVersionArgs('terraform')).toEqual(['version']));
  test('tofu uses version', () => expect(getVersionArgs('tofu')).toEqual(['version']));
  test('terragrunt uses --version', () => expect(getVersionArgs('terragrunt')).toEqual(['--version']));
  test('tg uses --version', () => expect(getVersionArgs('tg')).toEqual(['--version']));
});
