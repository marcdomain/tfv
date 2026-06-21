const https = require('https');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { getPaths, initDirs } = require('../utils/paths');
const { formatVersions, formatOpenTofuVersions } = require('../utils/formatVersions');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const URLS = {
  terraform: 'https://releases.hashicorp.com/terraform/index.json',
  opentofu: 'https://api.github.com/repos/opentofu/opentofu/releases?per_page=100',
};

const fetchUrl = (url) => new Promise((resolve, reject) => {
  const options = { headers: { 'User-Agent': 'tfv-cli' } };
  https.get(url, options, (res) => {
    // Follow single redirect
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return fetchUrl(res.headers.location).then(resolve).catch(reject);
    }
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => resolve(data));
  }).on('error', reject);
});

const getCacheFile = (provider) => {
  initDirs();
  return join(getPaths().cache, `${provider}-versions.json`);
};

const readCache = (provider) => {
  const cacheFile = getCacheFile(provider);
  if (!existsSync(cacheFile)) return null;
  try {
    const { timestamp, data } = JSON.parse(readFileSync(cacheFile, 'utf-8'));
    if (Date.now() - timestamp < CACHE_TTL_MS) return data;
  } catch (_) { /* ignore corrupt cache */ }
  return null;
};

const writeCache = (provider, data) => {
  try {
    writeFileSync(getCacheFile(provider), JSON.stringify({ timestamp: Date.now(), data }));
  } catch (_) { /* non-fatal */ }
};

/**
 * Fetch all stable versions for a given provider.
 * Returns sorted array of version strings (descending).
 */
exports.fetchAllVersions = async (provider = 'terraform') => {
  const normalized = provider === 'tofu' ? 'opentofu' : provider;

  const cached = readCache(normalized);
  if (cached) return cached;

  const raw = await fetchUrl(URLS[normalized]);
  const versions = normalized === 'opentofu'
    ? formatOpenTofuVersions(raw)
    : formatVersions(raw);

  writeCache(normalized, versions);
  return versions;
};

/**
 * Fetch raw response (used for SHA256 sums and other direct URLs).
 */
exports.fetchUrl = fetchUrl;

