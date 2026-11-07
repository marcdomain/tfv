import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { hashPassword, verifyPassword, sign, unsign, RateLimiter, Oidc, type AuthConfig } from '../src/auth.ts';
import { createHttpServer } from '../src/http.ts';
import { Store } from '../src/store.ts';

describe('passwords and signed values', () => {
  test('scrypt hashes verify and are salted', () => {
    const h = hashPassword('correct horse battery staple');
    assert.match(h, /^scrypt\$16384\$8\$1\$/);
    assert.notEqual(h, hashPassword('correct horse battery staple'));
    assert.equal(verifyPassword('correct horse battery staple', h), true);
    assert.equal(verifyPassword('wrong', h), false);
    assert.equal(verifyPassword('x', 'md5$abc'), false);
  });

  test('signed values reject tampering and expiry', () => {
    const v = sign({ sub: 'a', role: 'viewer', exp: Math.floor(Date.now() / 1000) + 60 }, 's'.repeat(32));
    assert.equal(unsign<any>(v, 's'.repeat(32))?.sub, 'a');
    assert.equal(unsign(v, 't'.repeat(32)), null);
    const [body, mac] = v.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'a', role: 'admin', exp: 9e9 })).toString('base64url');
    assert.equal(unsign(`${forged}.${mac}`, 's'.repeat(32)), null);
    assert.equal(unsign(`${body}.${mac}x`, 's'.repeat(32)), null);
    assert.equal(unsign(sign({ exp: 1 }, 's'.repeat(32)), 's'.repeat(32)), null);
  });

  test('rate limiter', () => {
    const r = new RateLimiter(2, 60_000);
    assert.deepEqual([r.allow('k'), r.allow('k'), r.allow('k')], [true, true, false]);
    r.reset('k');
    assert.equal(r.allow('k'), true);
  });
});

// ---- HTTP: sign-in, sessions, roles, single sign-on --------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
let idp: Server;
let idpUrl: string;
let srv: Server;
let base: string;
let store: Store;
let groups: string[] = ['tfv-admins'];
let tamper = false;
const codes = new Map<string, { challenge: string; nonce: string }>();

const jwt = (claims: object) => {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey).toString('base64url');
  return `${h}.${p}.${tamper ? s.slice(0, -4) + 'AAAA' : s}`;
};

before(async () => {
  // A tiny OIDC provider: discovery, authorize (issues a code), token, JWKS.
  idp = createServer(async (req, res) => {
    const url = new URL(req.url!, idpUrl);
    let body = '';
    for await (const c of req) body += c;
    const json = (o: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({ issuer: idpUrl, authorization_endpoint: `${idpUrl}/authorize`, token_endpoint: `${idpUrl}/token`, jwks_uri: `${idpUrl}/keys` });
    }
    if (url.pathname === '/keys') return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
    if (url.pathname === '/token') {
      const f = new URLSearchParams(body);
      const c = codes.get(f.get('code')!);
      const auth = Buffer.from(String(req.headers.authorization).slice(6), 'base64').toString();
      const pkceOk = c && createHash('sha256').update(f.get('code_verifier')!).digest('base64url') === c.challenge;
      if (!pkceOk || auth !== 'tfv-client:tfv-secret') { res.writeHead(400); return res.end('{"error":"invalid_grant"}'); }
      const t = Math.floor(Date.now() / 1000);
      return json({ id_token: jwt({ iss: idpUrl, aud: 'tfv-client', sub: '00u1', name: 'Alice Okafor', email: 'alice@acme.dev', groups, nonce: c.nonce, iat: t, exp: t + 300 }) });
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => idp.listen(0, '127.0.0.1', () => r()));
  idpUrl = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;

  store = new Store(':memory:');
  store.acquireLock('github.com/acme/infra', 'envs/prod', 'default', 7, 'bob');
  const auth: AuthConfig = {
    apiToken: 'api-token-123456', sessionSecret: 'z'.repeat(32), sessionHours: 1, secureCookies: false,
    users: [
      { username: 'admin', password_hash: hashPassword('admin-password-1'), role: 'admin', name: 'Ada Admin' },
      { username: 'viewer', password_hash: hashPassword('viewer-password-1') },
    ],
    oidc: {
      issuer: '', clientId: 'tfv-client', clientSecret: 'tfv-secret', name: 'Okta', scopes: ['openid', 'groups'],
      groupsClaim: 'groups', adminGroups: ['tfv-admins'], allowedGroups: ['tfv-viewers'],
    },
  };
  auth.oidc!.issuer = idpUrl;
  srv = createHttpServer({
    app: {} as any, store, adapters: {}, auth, ready: () => true,
    oidc: new Oidc(auth.oidc!, 'http://tfv.test'), loginLimiter: new RateLimiter(5, 60_000),
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});

after(() => { srv.close(); idp.close(); store.close(); });

const login = (username: string, password: string, headers: Record<string, string> = { 'X-Requested-With': 'tfv' }) =>
  fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ username, password }) });
const cookieOf = (res: Response) => res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

describe('dashboard HTTP auth', () => {
  test('sign-in options reflect the server config', async () => {
    assert.deepEqual(await (await fetch(`${base}/auth/config`)).json(), { password: true, oidc: { name: 'Okta' }, token: true });
  });

  test('API needs a session or token', async () => {
    assert.equal((await fetch(`${base}/api/runs`)).status, 401);
    assert.equal((await fetch(`${base}/api/runs`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(`${base}/api/me`, { headers: { Authorization: 'Bearer api-token-123456' } })).status, 200);
  });

  test('password sign-in sets an HttpOnly cookie; wrong passwords are refused', async () => {
    assert.equal((await login('admin', 'wrong-password')).status, 401);
    assert.equal((await login('ghost', 'whatever')).status, 401);
    assert.equal((await login('admin', 'admin-password-1', {})).status, 403, 'needs the X-Requested-With header');
    const res = await login('admin', 'admin-password-1');
    assert.equal(res.status, 200);
    const raw = res.headers.getSetCookie()[0];
    assert.match(raw, /^tfv_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600$/);
    const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: cookieOf(res) } })).json();
    assert.deepEqual(me, { name: 'Ada Admin', role: 'admin', via: 'password', platforms: [] });
  });

  test('viewers read; only admins act; cookie writes need the CSRF header', async () => {
    const viewer = cookieOf(await login('viewer', 'viewer-password-1'));
    const admin = cookieOf(await login('admin', 'admin-password-1'));
    const unlock = (cookie: string, extra: Record<string, string> = { 'X-Requested-With': 'tfv' }) => fetch(`${base}/api/locks/unlock`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify({ repo: 'github.com/acme/infra', project: 'envs/prod', workspace: 'default' }),
    });
    assert.equal((await fetch(`${base}/api/locks`, { headers: { Cookie: viewer } })).status, 200);
    assert.equal((await unlock(viewer)).status, 403);
    assert.equal((await unlock(admin, {})).status, 403, 'cross-site style request without the header');
    assert.equal((await unlock(admin)).status, 200);
    assert.equal(store.auditLog(1)[0].user, 'Ada Admin');
  });

  test('too many attempts are throttled', async () => {
    for (let i = 0; i < 5; i++) await login('viewer', 'nope');
    assert.equal((await login('viewer', 'viewer-password-1')).status, 429);
  });

  const sso = async () => {
    const start = await fetch(`${base}/auth/oidc/login`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get('location')!);
    assert.equal(to.origin + to.pathname, `${idpUrl}/authorize`);
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(to.searchParams.get('redirect_uri'), 'http://tfv.test/auth/oidc/callback');
    const code = `code-${Math.random()}`;
    codes.set(code, { challenge: to.searchParams.get('code_challenge')!, nonce: to.searchParams.get('nonce')! });
    return { state: to.searchParams.get('state')!, code, cookie: cookieOf(start) };
  };
  const callback = (q: string, cookie: string) => fetch(`${base}/auth/oidc/callback?${q}`, { redirect: 'manual', headers: { Cookie: cookie } });

  test('Okta sign-in: PKCE + nonce + signature; admin group becomes admin', async () => {
    groups = ['tfv-admins'];
    const { state, code, cookie } = await sso();
    const res = await callback(`code=${code}&state=${state}`, cookie);
    assert.equal(res.headers.get('location'), '/#overview');
    const session = res.headers.getSetCookie().find(c => c.startsWith('tfv_session='))!.split(';')[0];
    const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: session } })).json();
    assert.deepEqual(me, { name: 'Alice Okafor', role: 'admin', via: 'oidc', platforms: [] });
  });

  test('Okta sign-in: allowed group becomes viewer; others are refused', async () => {
    groups = ['tfv-viewers'];
    let s = await sso();
    let res = await callback(`code=${s.code}&state=${s.state}`, s.cookie);
    const session = res.headers.getSetCookie().find(c => c.startsWith('tfv_session='))!.split(';')[0];
    assert.equal((await (await fetch(`${base}/api/me`, { headers: { Cookie: session } })).json()).role, 'viewer');

    groups = ['marketing'];
    s = await sso();
    res = await callback(`code=${s.code}&state=${s.state}`, s.cookie);
    assert.match(decodeURIComponent(res.headers.get('location')!), /not in a group allowed/);
    assert.ok(!res.headers.getSetCookie().some(c => c.startsWith('tfv_session=') && !c.includes('Max-Age=0')));
  });

  test('Okta sign-in: wrong state, missing cookie and bad signatures fail', async () => {
    groups = ['tfv-admins'];
    let s = await sso();
    assert.match(decodeURIComponent((await callback(`code=${s.code}&state=other`, s.cookie)).headers.get('location')!), /state did not match/);
    s = await sso();
    assert.match(decodeURIComponent((await callback(`code=${s.code}&state=${s.state}`, '')).headers.get('location')!), /sign-in expired/);
    tamper = true;
    s = await sso();
    assert.match(decodeURIComponent((await callback(`code=${s.code}&state=${s.state}`, s.cookie)).headers.get('location')!), /signature is invalid/);
    tamper = false;
  });

  test('dashboard is served with a strict content security policy', async () => {
    const res = await fetch(`${base}/`);
    if (res.status === 404) return; // web files not present in this checkout
    assert.match(res.headers.get('content-security-policy')!, /default-src 'self'/);
  });
});
