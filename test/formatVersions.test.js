const {
  formatVersions, formatAllVersions,
  formatOpenTofuVersions, formatAllOpenTofuVersions,
  semverDesc,
} = require('../lib/utils/formatVersions');

describe('formatVersions (Terraform JSON API)', () => {
  const mockApiResponse = {
    versions: {
      '1.7.3': { name: 'terraform', version: '1.7.3' },
      '1.7.0': { name: 'terraform', version: '1.7.0' },
      '1.6.6': { name: 'terraform', version: '1.6.6' },
      '1.8.0-beta1': { name: 'terraform', version: '1.8.0-beta1' },
      '0.14.0': { name: 'terraform', version: '0.14.0' },
    }
  };

  test('parses versions from JSON object', () => {
    const result = formatVersions(mockApiResponse);
    expect(result).toContain('1.7.3');
    expect(result).toContain('1.6.6');
    expect(result).toContain('0.14.0');
  });

  test('excludes pre-release versions', () => {
    const result = formatVersions(mockApiResponse);
    expect(result).not.toContain('1.8.0-beta1');
  });

  test('sorts versions descending', () => {
    const result = formatVersions(mockApiResponse);
    expect(result[0]).toBe('1.7.3');
    expect(result[1]).toBe('1.7.0');
    expect(result[2]).toBe('1.6.6');
  });

  test('accepts a JSON string', () => {
    const result = formatVersions(JSON.stringify(mockApiResponse));
    expect(result).toContain('1.7.3');
  });
});

describe('formatAllVersions (Terraform — includes pre-releases)', () => {
  const mockApiResponse = {
    versions: {
      '1.8.0-beta1': {},
      '1.7.3': {},
      '1.7.0-rc1': {},
      '1.6.6': {},
    }
  };

  test('includes pre-release versions', () => {
    const result = formatAllVersions(mockApiResponse);
    expect(result).toContain('1.8.0-beta1');
    expect(result).toContain('1.7.0-rc1');
  });

  test('still includes stable versions', () => {
    const result = formatAllVersions(mockApiResponse);
    expect(result).toContain('1.7.3');
  });

  test('sorts descending', () => {
    const result = formatAllVersions(mockApiResponse);
    expect(result[0]).toBe('1.8.0-beta1');
  });
});

describe('formatOpenTofuVersions (GitHub Releases API)', () => {
  const mockReleases = [
    { tag_name: 'v1.7.3', prerelease: false, draft: false },
    { tag_name: 'v1.7.0', prerelease: false, draft: false },
    { tag_name: 'v1.8.0-alpha1', prerelease: true, draft: false },
    { tag_name: 'v1.6.5', prerelease: false, draft: true },
  ];

  test('strips v prefix from versions', () => {
    const result = formatOpenTofuVersions(mockReleases);
    result.forEach(v => expect(v).not.toMatch(/^v/));
  });

  test('excludes pre-releases and drafts', () => {
    const result = formatOpenTofuVersions(mockReleases);
    expect(result).not.toContain('1.8.0-alpha1');
    expect(result).not.toContain('1.6.5');
  });

  test('sorts versions descending', () => {
    const result = formatOpenTofuVersions(mockReleases);
    expect(result[0]).toBe('1.7.3');
    expect(result[1]).toBe('1.7.0');
  });
});

describe('formatAllOpenTofuVersions (includes pre-releases)', () => {
  const mockReleases = [
    { tag_name: 'v1.8.0-alpha1', prerelease: true, draft: false },
    { tag_name: 'v1.7.3', prerelease: false, draft: false },
    { tag_name: 'v1.6.5', prerelease: false, draft: true },  // drafts still excluded
  ];

  test('includes pre-release builds', () => {
    const result = formatAllOpenTofuVersions(mockReleases);
    expect(result).toContain('1.8.0-alpha1');
  });

  test('excludes draft releases', () => {
    const result = formatAllOpenTofuVersions(mockReleases);
    expect(result).not.toContain('1.6.5');
  });
});

describe('semverDesc', () => {
  test('sorts major versions correctly', () => {
    expect(['1.0.0', '2.0.0', '0.9.0'].sort(semverDesc)).toEqual(['2.0.0', '1.0.0', '0.9.0']);
  });

  test('sorts minor versions correctly', () => {
    expect(['1.3.0', '1.10.0', '1.2.0'].sort(semverDesc)).toEqual(['1.10.0', '1.3.0', '1.2.0']);
  });

  test('sorts patch versions correctly', () => {
    expect(['1.7.1', '1.7.3', '1.7.2'].sort(semverDesc)).toEqual(['1.7.3', '1.7.2', '1.7.1']);
  });
});
