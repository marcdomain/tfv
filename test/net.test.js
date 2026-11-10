// Downloads survive the kind of failures GitHub has (5xx, dropped connections),
// give up straight away on real errors, and never leak the token to other hosts.
const http = require('http');
const { fetchUrl } = require('../lib/modules/remote');
const { headersFor, withRetry, isTransient } = require('../lib/utils/net');

let server;
let base;
let hits;
const routes = {};

beforeAll(async () => {
  process.env.TERIAC_RETRY_DELAY_MS = '1';
  server = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    const route = routes[req.url];
    if (!route) { res.writeHead(404); return res.end('nope'); }
    route(req, res, hits[req.url]);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => { delete process.env.TERIAC_RETRY_DELAY_MS; server.close(); });
beforeEach(() => { hits = {}; });

test('a 504 (GitHub timing out) is retried until it works', async () => {
  routes['/flaky'] = (req, res, n) => {
    if (n < 3) { res.writeHead(504); return res.end('Gateway Timeout'); }
    res.writeHead(200); res.end('abc123  tofu_1.8.5_linux_amd64.zip\n');
  };
  await expect(fetchUrl(`${base}/flaky`)).resolves.toMatch(/tofu_1\.8\.5/);
  expect(hits['/flaky']).toBe(3);
});

test('a dropped connection is retried', async () => {
  routes['/drop'] = (req, res, n) => {
    if (n === 1) return req.socket.destroy();
    res.writeHead(200); res.end('ok');
  };
  await expect(fetchUrl(`${base}/drop`)).resolves.toBe('ok');
  expect(hits['/drop']).toBe(2);
});

test('a 404 fails straight away, and retries stop after 4 tries', async () => {
  await expect(fetchUrl(`${base}/missing`)).rejects.toThrow(/HTTP 404/);
  expect(hits['/missing']).toBe(1);
  routes['/down'] = (req, res) => { res.writeHead(503); res.end(); };
  await expect(fetchUrl(`${base}/down`)).rejects.toThrow(/HTTP 503/);
  expect(hits['/down']).toBe(4);
});

test('which errors are worth retrying', () => {
  expect(isTransient(new Error('HTTP 504 from x'))).toBe(true);
  expect(isTransient(new Error('no tofu download (HTTP 502)'))).toBe(true);
  expect(isTransient(new Error('HTTP 429'))).toBe(true);
  expect(isTransient(new Error('socket hang up'))).toBe(true);
  expect(isTransient(new Error('timed out after 60s'))).toBe(true);
  expect(isTransient(new Error('HTTP 404 from x'))).toBe(false);
  expect(isTransient(new Error('checksum mismatch'))).toBe(false);
});

test('withRetry reports each retry', async () => {
  const seen = [];
  let n = 0;
  const r = await withRetry(async () => { if (++n < 2) throw new Error('HTTP 500'); return 'done'; }, { onRetry: (e, i) => seen.push(`${i}:${e.message}`) });
  expect(r).toBe('done');
  expect(seen).toEqual(['1:HTTP 500']);
});

test('the GitHub token goes to GitHub only, never to the download storage host', () => {
  process.env.GITHUB_TOKEN = 'ghs_test';
  try {
    expect(headersFor('https://api.github.com/repos/x/y').Authorization).toBe('Bearer ghs_test');
    expect(headersFor('https://github.com/opentofu/opentofu/releases/download/v1.8.5/x.zip').Authorization).toBe('Bearer ghs_test');
    expect(headersFor('https://objects.githubusercontent.com/github-production-release-asset/x').Authorization).toBeUndefined();
    expect(headersFor('https://releases.hashicorp.com/terraform/1.9.8/x.zip').Authorization).toBeUndefined();
    expect(headersFor('https://mirror.example.com/github.com/x').Authorization).toBeUndefined();
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test('a token handed over in-process is used for GitHub (an env GITHUB_TOKEN wins)', () => {
  const { setDownloadToken } = require('../lib/utils/net');
  setDownloadToken('ghs_app');
  try {
    expect(headersFor('https://github.com/x/releases/download/v1/x').Authorization).toBe('Bearer ghs_app');
    expect(headersFor('https://objects.githubusercontent.com/x').Authorization).toBeUndefined();
    expect(process.env.GITHUB_TOKEN).toBeUndefined(); // never put in the environment
    process.env.GITHUB_TOKEN = 'ghs_env';
    expect(headersFor('https://api.github.com/x').Authorization).toBe('Bearer ghs_env');
  } finally {
    delete process.env.GITHUB_TOKEN;
    setDownloadToken(null);
  }
});
