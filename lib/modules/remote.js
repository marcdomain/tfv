const { applyMirror, clientFor } = require('../utils/mirror');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { getPaths, initDirs, normalizeProvider } = require('../utils/paths');
const { formatVersions, formatOpenTofuVersions, formatTagVersions } = require('../utils/formatVersions');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const URLS = {
  terraform: 'https://releases.hashicorp.com/terraform/index.json',
  opentofu: 'https://api.github.com/repos/opentofu/opentofu/releases?per_page=100',
  // Terragrunt has ~900 releases; tags come back in one request instead of 10 pages.
  terragrunt: 'https://api.github.com/repos/gruntwork-io/terragrunt/git/matching-refs/tags/v',
};

const PARSERS = {
  terraform: formatVersions,
  opentofu: formatOpenTofuVersions,
  terragrunt: formatTagVersions,
};

// GitHub allows 60 anonymous API requests an hour; a token raises that.
const headersFor = (url) => {
  const headers = { 'User-Agent': 'tfv-cli' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token && url.startsWith('https://api.github.com/')) headers.Authorization = `Bearer ${token}`;
  return headers;
};

const fetchUrl = (url) => new Promise((resolve, reject) => {
  const options = { headers: headersFor(url) };
  clientFor(url).get(url, options, (res) => {
    // Follow single redirect
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return fetchUrl(new URL(res.headers.location, url).href).then(resolve).catch(reject);
    }
    if (res.statusCode >= 400) {
      res.resume();
      const hint = res.statusCode === 403 ? ' (GitHub rate limit? set GITHUB_TOKEN)' : '';
      return reject(new Error(`HTTP ${res.statusCode} from ${url}${hint}`));
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
  const normalized = normalizeProvider(provider);

  const cached = readCache(normalized);
  if (cached) return cached;

  const raw = await fetchUrl(applyMirror(URLS[normalized]));
  const versions = PARSERS[normalized](raw);

  writeCache(normalized, versions);
  return versions;
};

/**
 * Fetch raw response (used for SHA256 sums and other direct URLs).
 */
exports.fetchUrl = fetchUrl;

