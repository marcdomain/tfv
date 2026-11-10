const { env } = require('./env');
// Network helpers for release downloads: per-host headers, retries and timeouts.
// Downloads come from GitHub, HashiCorp or a mirror; GitHub sometimes times out
// (HTTP 5xx), so temporary failures are retried a few times before giving up.

// A token handed over in-process (teriac server sets its GitHub App's). Kept out of the
// environment on purpose: Terraform runs inherit the environment, and providers
// such as GitHub's read GITHUB_TOKEN.
let downloadToken = null;
const setDownloadToken = (token) => { downloadToken = token || null; };

// GitHub token, when set, for GitHub hosts only. Never sent to the storage host a
// release download redirects to (it uses its own signed URL and rejects extra auth).
const headersFor = (url) => {
  const headers = { 'User-Agent': 'teriac-cli' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || downloadToken;
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { /* not a URL */ }
  if (token && (host === 'api.github.com' || host === 'github.com')) headers.Authorization = `Bearer ${token}`;
  return headers;
};

// A connection that stays silent this long is dropped (and retried).
const IDLE_TIMEOUT_MS = 60 * 1000;

// Worth trying again: server errors, rate limits, dropped or stalled connections.
// Not worth it: 404, 403 and other client errors, checksum mismatches.
const isTransient = (err) =>
  /HTTP (5\d\d|429)\b|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|timed out/i
    .test(String((err && err.message) || ''));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Runs fn; on a temporary failure waits and tries again (4 tries: waits 2s, 5s, 10s).
// TERIAC_RETRY_DELAY_MS overrides the waits (tests).
const withRetry = async (fn, { attempts = 4, delays = [2000, 5000, 10000], onRetry } = {}) => {
  for (let i = 1; ; i++) {
    try {
      return await fn(i);
    } catch (err) {
      if (i >= attempts || !isTransient(err)) throw err;
      const override = env('RETRY_DELAY_MS');
      const wait = override !== undefined
        ? Number(override)
        : delays[Math.min(i - 1, delays.length - 1)];
      if (onRetry) onRetry(err, i, wait);
      await sleep(wait);
    }
  }
};

module.exports = { headersFor, isTransient, withRetry, setDownloadToken, IDLE_TIMEOUT_MS };
