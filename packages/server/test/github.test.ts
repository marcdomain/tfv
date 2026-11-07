import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, createVerify } from 'node:crypto';
import { GitHubAdapter, appJwt, verifySignature } from '../src/vcs/github.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const cfg = { appId: '123', privateKey: pem, webhookSecret: 'whsec-test-123', apiUrl: 'https://api.github.com', host: 'github.com' };

test('webhook signatures', () => {
  const body = Buffer.from('{"a":1}');
  const sig = `sha256=${createHmac('sha256', cfg.webhookSecret).update(body).digest('hex')}`;
  assert.equal(verifySignature(cfg.webhookSecret, body, sig), true);
  assert.equal(verifySignature(cfg.webhookSecret, Buffer.from('{"a":2}'), sig), false);
  assert.equal(verifySignature(cfg.webhookSecret, body, undefined), false);
  assert.equal(verifySignature(cfg.webhookSecret, body, 'sha256=00'), false);
});

test('app JWT is RS256-signed with a short expiry', () => {
  const jwt = appJwt('123', pem, 1_000_000);
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), { iat: 999_940, exp: 1_000_540, iss: '123' });
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${p}`);
  assert.ok(v.verify(publicKey, Buffer.from(s, 'base64url')));
});

const gh = new GitHubAdapter(cfg);
const repository = { name: 'infra', full_name: 'acme/infra', owner: { login: 'acme' }, clone_url: 'https://github.com/acme/infra.git' };
const pull = {
  number: 7, title: 't', html_url: 'u', user: { login: 'bob' }, draft: false, merged: false,
  head: { sha: 'abc', ref: 'feat', repo: { full_name: 'acme/infra' } }, base: { ref: 'main', repo: { full_name: 'acme/infra' } },
};

test('parses PR, comment and Apply-button events', () => {
  const pr = gh.parse({ 'x-github-event': 'pull_request' }, { action: 'synchronize', repository, installation: { id: 9 }, pull_request: pull });
  assert.equal(pr.kind, 'pr_updated');
  assert.equal(pr.kind === 'pr_updated' && pr.repo.installationId, 9);

  const c = gh.parse({ 'x-github-event': 'issue_comment' }, {
    action: 'created', repository, issue: { number: 7, pull_request: {} }, comment: { id: 55, body: 'tfv plan', user: { login: 'bob', type: 'User' } },
  });
  assert.deepEqual(c.kind === 'comment' && [c.prNumber, c.commentId, c.author, c.body], [7, '55', 'bob', 'tfv plan']);

  const bot = gh.parse({ 'x-github-event': 'issue_comment' }, {
    action: 'created', repository, issue: { number: 7, pull_request: {} }, comment: { id: 56, body: 'tfv apply', user: { login: 'x[bot]', type: 'Bot' } },
  });
  assert.equal(bot.kind, 'ignored');

  const button = gh.parse({ 'x-github-event': 'check_run' }, {
    action: 'requested_action', repository, requested_action: { identifier: 'apply' }, sender: { login: 'erin' },
    check_run: { external_id: 'envs/prod', pull_requests: [{ number: 7 }] },
  });
  assert.deepEqual(button.kind === 'apply_button' && [button.prNumber, button.project, button.user], [7, 'envs/prod', 'erin']);

  const fork = gh.parse({ 'x-github-event': 'pull_request' }, {
    action: 'opened', repository, pull_request: { ...pull, head: { ...pull.head, repo: { full_name: 'stranger/infra' } } },
  });
  assert.equal(fork.kind === 'pr_opened' && fork.pr.fromFork, true);
});

test('permission lookup maps GitHub roles and caches', async () => {
  let calls = 0;
  const fake: typeof fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 'ghs_faketoken', expires_at: new Date(Date.now() + 3600e3).toISOString() }));
    calls++;
    if (u.includes('/collaborators/erin/')) return new Response(JSON.stringify({ permission: 'write', role_name: 'maintain' }));
    if (u.includes('/memberships/carol')) return new Response(JSON.stringify({ state: 'active' }));
    return new Response('{"message":"Not Found"}', { status: 404 });
  };
  const a = new GitHubAdapter(cfg, fake);
  const repo = { platform: 'github' as const, host: 'github.com', owner: 'acme', name: 'infra', fullName: 'acme/infra', cloneUrl: '', installationId: 9 };
  assert.equal(await a.userPermission(repo, 'erin'), 'maintain');
  assert.equal(await a.userPermission(repo, 'erin'), 'maintain');
  assert.equal(await a.userPermission(repo, 'nobody'), 'none');
  assert.equal(await a.inTeam(repo, 'platform-admins', 'carol'), true);
  assert.equal(await a.inTeam(repo, 'other-org/platform-admins', 'dave'), false);
  assert.equal(calls, 4); // erin's second lookup came from the cache
});
