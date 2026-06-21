const { join } = require('path');
const { homedir } = require('os');
const {
  TFV_HOME,
  getPaths,
  normalizeProvider,
  getCliName,
  getProviderStore,
} = require('../lib/utils/paths');

describe('TFV_HOME', () => {
  test('is under the user home directory', () => {
    expect(TFV_HOME).toBe(join(homedir(), '.tfv'));
  });
});

describe('getPaths', () => {
  const paths = getPaths();

  test('bin is inside TFV_HOME', () => {
    expect(paths.bin).toBe(join(TFV_HOME, 'bin'));
  });

  test('store is inside TFV_HOME', () => {
    expect(paths.store).toBe(join(TFV_HOME, 'store'));
  });

  test('terraform store is correct', () => {
    expect(paths.terraform).toBe(join(TFV_HOME, 'store', 'terraform'));
  });

  test('opentofu store is correct', () => {
    expect(paths.opentofu).toBe(join(TFV_HOME, 'store', 'opentofu'));
  });

  test('active.json is in TFV_HOME', () => {
    expect(paths.active).toBe(join(TFV_HOME, 'active.json'));
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
    expect(getProviderStore()).toBe(join(TFV_HOME, 'store', 'terraform'));
  });

  test('returns opentofu store for tofu alias', () => {
    expect(getProviderStore('tofu')).toBe(join(TFV_HOME, 'store', 'opentofu'));
  });

  test('returns opentofu store', () => {
    expect(getProviderStore('opentofu')).toBe(join(TFV_HOME, 'store', 'opentofu'));
  });
});
