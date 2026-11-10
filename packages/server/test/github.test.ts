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
    action: 'created', repository, issue: { number: 7, pull_request: {} }, comment: { id: 55, body: 'teriac plan', user: { login: 'bob', type: 'User' } },
  });
  assert.deepEqual(c.kind === 'comment' && [c.prNumber, c.commentId, c.author, c.body], [7, '55', 'bob', 'teriac plan']);

  const bot = gh.parse({ 'x-github-event': 'issue_comment' }, {
    action: 'created', repository, issue: { number: 7, pull_request: {} }, comment: { id: 56, body: 'teriac apply', user: { login: 'x[bot]', type: 'Bot' } },
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

test('approvals on later pages of reviews are found (pagination)', async () => {
  // 250 reviews over 3 pages; the only approval of the head commit is on page 3.
  const all = Array.from({ length: 250 }, (_, i) => ({ id: i, user: { login: `u${i}` }, state: 'COMMENTED', commit_id: 'head' }));
  all[245] = { id: 245, user: { login: 'carol' }, state: 'APPROVED', commit_id: 'head' };
  const fake: typeof fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString() }));
    const page = Number(u.searchParams.get('page') ?? 1);
    const items = all.slice((page - 1) * 100, page * 100);
    const next = page < 3 ? `<https://api.github.com/repos/acme/infra/pulls/7/reviews?per_page=100&page=${page + 1}>; rel="next"` : '';
    return new Response(JSON.stringify(items), { headers: next ? { link: next } : {} });
  };
  const a = new GitHubAdapter(cfg, fake);
  const repo = { platform: 'github' as const, host: 'github.com', owner: 'acme', name: 'infra', fullName: 'acme/infra', cloneUrl: '', installationId: 9 };
  const reviews = await a.reviews(repo, 7);
  assert.equal(reviews.length, 250);
  assert.deepEqual(reviews.filter(r => r.state === 'approved').map(r => r.user), ['carol']);
});

test('the single updating comment is edited by id, without listing comments', async () => {
  const calls: string[] = [];
  const fake: typeof fetch = async (url, init) => {
    const u = String(url);
    calls.push(`${init?.method ?? 'GET'} ${new URL(u).pathname}`);
    if (u.endsWith('/access_tokens')) return new Response(JSON.stringify({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString() }));
    if (u.includes('/issues/comments/111')) return new Response(JSON.stringify({ id: 111, html_url: 'https://github.com/c/111' }));
    return new Response('{}', { status: 404 });
  };
  const a = new GitHubAdapter(cfg, fake);
  const repo = { platform: 'github' as const, host: 'github.com', owner: 'acme', name: 'infra', fullName: 'acme/infra', cloneUrl: '', installationId: 9 };
  assert.deepEqual(await a.upsertComment(repo, 7, 'M', 'body', '111'), { id: '111', url: 'https://github.com/c/111' });
  assert.deepEqual(calls.filter(c => !c.includes('access_tokens')), ['PATCH /repos/acme/infra/issues/comments/111']);
});

test('webhook: someone else editing a bot comment is reported; the bot editing its own is not', async () => {
  const base = { repository, issue: { number: 7, pull_request: {} } };
  const ev = (sender: string): any => gh.parse({ 'x-github-event': 'issue_comment' }, {
    ...base, action: 'edited', sender: { login: sender }, comment: { id: 5, body: 'x', user: { login: 'teriac[bot]', type: 'Bot' } },
  });
  assert.deepEqual({ ...ev('mallory'), repo: undefined }, { kind: 'bot_comment_changed', repo: undefined, prNumber: 7, commentId: '5', by: 'mallory', change: 'edited', body: 'x' });
  assert.equal(ev('teriac[bot]').kind, 'ignored');
});

test('a repo with no installation id (dashboard, schedules) finds it once and reuses it', async () => {
  const seen: string[] = [];
  const fake: typeof fetch = async (url) => {
    const u = String(url);
    seen.push(u.replace('https://api.github.com', ''));
    if (u.endsWith('/repos/acme/infra/installation')) return new Response(JSON.stringify({ id: 77 }));
    if (u.endsWith('/app/installations/77/access_tokens')) return new Response(JSON.stringify({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString() }));
    if (u.includes('/issues/1/comments')) return new Response(JSON.stringify({ id: 5, html_url: 'u' }), { status: 201 });
    return new Response('{"message":"Not Found"}', { status: 404 });
  };
  const a = new GitHubAdapter(cfg, fake);
  const repo = { platform: 'github' as const, host: 'github.com', owner: 'acme', name: 'infra', fullName: 'acme/infra', cloneUrl: '' };
  assert.equal(await a.comment(repo, 1, 'hi'), '5');
  assert.equal(await a.comment(repo, 1, 'again'), '5');
  assert.equal(seen.filter(u => u.endsWith('/installation')).length, 1, 'looked up once');
  // Not installed on the repo: a clear error.
  const none = new GitHubAdapter(cfg, async () => new Response('{}', { status: 404 }));
  await assert.rejects(none.comment({ ...repo, fullName: 'acme/other' }, 1, 'x'), /no GitHub App installation for acme\/other \(HTTP 404\); is the App installed on it\?/);
});

test('download token: from any installation of the App, github.com only', async () => {
  const fake: typeof fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/app/installations?per_page=1')) return new Response(JSON.stringify([{ id: 31, account: { login: 'acme' } }]));
    if (u.endsWith('/app/installations/31/access_tokens')) return new Response(JSON.stringify({ token: 'ghs_dl', expires_at: new Date(Date.now() + 3600e3).toISOString() }));
    return new Response('{}', { status: 404 });
  };
  assert.equal(await new GitHubAdapter(cfg, fake).downloadToken(), 'ghs_dl');
  assert.equal(await new GitHubAdapter({ ...cfg, host: 'github.acme.internal', apiUrl: 'https://github.acme.internal/api/v3' }, fake).downloadToken(), null, 'Enterprise App: not for github.com');
  const none: typeof fetch = async () => new Response('[]');
  assert.equal(await new GitHubAdapter(cfg, none).downloadToken(), null, 'not installed anywhere');
});
