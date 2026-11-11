// The dashboard's emergency-access routes: who may grant and revoke, what is audited,
// and what the channels are told.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashPassword, type AuthConfig } from '../src/auth.ts';
import { createHttpServer } from '../src/http.ts';
import { Store } from '../src/store.ts';

let srv: Server;
let base: string;
let store: Store;
const sent: { event: string; title: string }[] = [];

const auth: AuthConfig = {
  apiToken: 'api-token-for-tests-1234567890',
  sessionSecret: 's'.repeat(32), sessionHours: 1, secureCookies: false,
  users: [
    { username: 'ada', password_hash: hashPassword('pw-ada-123'), role: 'admin' },
    { username: 'vic', password_hash: hashPassword('pw-vic-123'), role: 'viewer' },
    { username: 'lead', name: 'SRE Lead', password_hash: hashPassword('pw-lead-123'), role: 'viewer' },
  ],
};

before(async () => {
  store = new Store(':memory:');
  const fetchImpl = (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response('ok'); }) as typeof fetch;
  srv = createHttpServer({
    app: { runQueue: null } as any, store, adapters: {}, auth, ready: () => true,
    grants: { store, cfg: { grantors: ['admin', 'user:lead'], max_hours: 4, notify: ['ops'] }, channels: { ops: { type: 'webhook', webhook_url_env: 'HOOK' } }, people: [], env: { HOOK: 'https://hook.test' }, fetchImpl },
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
after(() => { srv.close(); store.close(); });

const signIn = async (username: string, password: string) => {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'teriac' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
};
const call = (cookie: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { Cookie: cookie, 'X-Requested-With': 'teriac', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const grant = { user: 'octocat', projects: 'prod/**', actions: ['apply'], bypass: ['approvals'], hours: 2, reason: 'INC-9: roll back the load balancer' };
const settle = () => new Promise(r => setTimeout(r, 50));

test('viewers see grants but cannot give them', async () => {
  const vic = await signIn('vic', 'pw-vic-123');
  const list = await (await call(vic, 'GET', '/api/grants')).json();
  assert.deepEqual([list.enabled, list.canGrant, list.maxHours], [true, false, 4]);
  const res = await call(vic, 'POST', '/api/grants', grant);
  assert.equal(res.status, 403);
  assert.equal(store.activeGrants().length, 0);
});

test('a named grantor gives access: stored, audited, announced', async () => {
  const lead = await signIn('lead', 'pw-lead-123');
  assert.equal((await (await call(lead, 'GET', '/api/grants')).json()).canGrant, true);
  const res = await call(lead, 'POST', '/api/grants', grant);
  assert.equal(res.status, 201);
  const g = await res.json();
  assert.deepEqual([g.user, g.projects, g.actions, g.bypass, g.grantedBy], ['octocat', ['prod/**'], ['apply'], ['approvals'], 'SRE Lead (password)']);
  const hours = (Date.parse(g.expiresAt) - Date.now()) / 3_600_000;
  assert.ok(hours > 1.9 && hours <= 2);
  assert.ok(store.auditLog(5).some(a => a.action === 'break_glass_granted' && /INC-9/.test(a.reason)));
  await settle();
  assert.equal(sent.at(-1)?.event, 'teriac.break_glass.granted');
});

test('bad requests explain what to fix', async () => {
  const ada = await signIn('ada', 'pw-ada-123');
  const res = await call(ada, 'POST', '/api/grants', { ...grant, hours: 10 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at most 4 hours/);
  const noHeader = await fetch(`${base}/api/grants`, { method: 'POST', headers: { Cookie: ada, 'Content-Type': 'application/json' }, body: JSON.stringify(grant) });
  assert.equal(noHeader.status, 403, 'browser writes need X-Requested-With');
});

test('revoke: admins and grantors only, once', async () => {
  const [g] = store.activeGrants();
  const vic = await signIn('vic', 'pw-vic-123');
  assert.equal((await call(vic, 'POST', `/api/grants/${g.id}/revoke`)).status, 403);
  const ada = await signIn('ada', 'pw-ada-123');
  const res = await call(ada, 'POST', `/api/grants/${g.id}/revoke`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).revokedBy, 'ada');
  assert.equal((await call(ada, 'POST', `/api/grants/${g.id}/revoke`)).status, 409);
  assert.equal((await call(ada, 'POST', '/api/grants/9999/revoke')).status, 404);
  assert.equal(store.activeGrants().length, 0);
  assert.ok(store.auditLog(5).some(a => a.action === 'break_glass_revoked'));
  await settle();
  assert.equal(sent.at(-1)?.event, 'teriac.break_glass.revoked');
});

test('without break_glass in repos.yaml, granting is off', async () => {
  const off = createHttpServer({ app: { runQueue: null } as any, store, adapters: {}, auth, ready: () => true });
  await new Promise<void>(r => off.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(off.address() as AddressInfo).port}`;
  const res = await fetch(`${url}/api/grants`, { method: 'POST', headers: { Authorization: `Bearer ${auth.apiToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(grant) });
  assert.equal(res.status, 404);
  assert.equal((await (await fetch(`${url}/api/grants`, { headers: { Authorization: `Bearer ${auth.apiToken}` } })).json()).enabled, false);
  off.close();
});
