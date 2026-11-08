import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoLinks, platformForHost } from '../src/links.ts';
import { presenter } from '../src/present.ts';

test('platform from host', () => {
  assert.equal(platformForHost('github.com'), 'github');
  assert.equal(platformForHost('ghe.acme.com', { 'ghe.acme.com': 'github' }), 'github');
  assert.equal(platformForHost('gitlab.acme.com'), 'gitlab');
  assert.equal(platformForHost('bitbucket.org'), 'bitbucket');
  assert.equal(platformForHost('dev.azure.com'), 'azure');
});

test('GitHub links', () => {
  const l = repoLinks('github.com/acme/infra', 'github');
  assert.equal(l.pr(42), 'https://github.com/acme/infra/pull/42');
  assert.equal(l.commit('abc'), 'https://github.com/acme/infra/commit/abc');
  assert.equal(l.tree('abc', 'envs/prod'), 'https://github.com/acme/infra/tree/abc/envs/prod');
  assert.equal(l.tree('abc', '.'), 'https://github.com/acme/infra/tree/abc/');
  assert.equal(l.file('abc', 'envs/prod/main.tf', 7, 12), 'https://github.com/acme/infra/blob/abc/envs/prod/main.tf#L7-L12');
  assert.equal(l.user('bob-m'), 'https://github.com/bob-m');
});

test('GitLab, Bitbucket and Azure DevOps links', () => {
  const g = repoLinks('gitlab.com/acme/platform/infra', 'gitlab');
  assert.equal(g.pr(3), 'https://gitlab.com/acme/platform/infra/-/merge_requests/3');
  assert.equal(g.file('abc', 'a/main.tf', 2, 5), 'https://gitlab.com/acme/platform/infra/-/blob/abc/a/main.tf#L2-5');
  const b = repoLinks('bitbucket.org/acme/infra', 'bitbucket');
  assert.equal(b.pr(9), 'https://bitbucket.org/acme/infra/pull-requests/9');
  assert.equal(b.file('abc', 'main.tf', 2, 5), 'https://bitbucket.org/acme/infra/src/abc/main.tf#lines-2:5');
  assert.equal(b.user('x'), null);
  const a = repoLinks('dev.azure.com/acme/Platform/infra', 'azure');
  assert.equal(a.pr(4), 'https://dev.azure.com/acme/Platform/_git/infra/pullrequest/4');
  assert.equal(a.commit('abc'), 'https://dev.azure.com/acme/Platform/_git/infra/commit/abc');
});

test('presenter attaches owners and links', () => {
  const show = presenter({}, [{ name: 'Alice', emails: ['alice@acme.dev'], github: 'alice-o' }]);
  const run = show.run({
    id: 1, repo: 'github.com/acme/infra', pr: 42, project: 'prod', dir: 'envs/prod', workspace: 'default', kind: 'plan',
    status: 'success', headSha: 'abc123', user: 'erin', prAuthor: 'bob', startedAt: '', finishedAt: null, engine: '',
    summary: null, output: '', planPath: null, hasChanges: true, destroys: 0, targets: [], policy: null, mocks: [], providers: [], usage: null, applied: null,
  });
  assert.deepEqual(run.links, {
    platform: 'GitHub', repo: 'https://github.com/acme/infra', pr: 'https://github.com/acme/infra/pull/42',
    commit: 'https://github.com/acme/infra/commit/abc123', tree: 'https://github.com/acme/infra/tree/abc123/envs/prod',
    user: 'https://github.com/erin', prAuthor: 'https://github.com/bob',
    userAvatar: '/avatars/github.com/erin', prAuthorAvatar: '/avatars/github.com/bob',
  });
  // Dashboard display names are not platform logins: no profile link.
  assert.equal(show.audit({ at: '', repo: 'github.com/acme/infra', pr: 7, user: 'Ada Admin', action: 'unlock', project: 'p', allowed: true, reason: '' }).links.user, null);

  const d = show.drift({
    repo: 'github.com/acme/infra', sha: 'head1', project: 'envs/prod',
    finding: {
      drift: [
        { address: 'a.b', action: 'update', author: { name: 'Alice', email: 'alice@acme.dev', sha: 'c1', file: 'envs/prod/main.tf', start: 3, end: 9 } },
        { address: 'c.d', action: 'delete', author: { name: 'Bob', email: '4821+bob-m@users.noreply.github.com', sha: 'c2' } },
      ],
      lastApply: { user: 'bob-m', pr: 37 },
    },
  });
  const [x, y] = d.finding.drift;
  assert.equal(x.links.file, 'https://github.com/acme/infra/blob/head1/envs/prod/main.tf#L3-L9');
  assert.equal(x.links.author, 'https://github.com/alice-o'); // from the people table
  assert.equal(y.links.author, 'https://github.com/bob-m');   // from the no-reply email
  assert.equal(y.links.file, 'https://github.com/acme/infra/tree/head1/envs/prod'); // no block found: project folder
  assert.equal(d.finding.lastApply.links.pr, 'https://github.com/acme/infra/pull/37');
});

test('avatars: only known hosts, cached, misses remembered', async () => {
  const { Avatars } = await import('../src/avatars.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tfv-av-'));
  let calls = 0;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const a = new Avatars(dir, { 'github.com': 'github' }, async (url) => {
    calls++;
    return String(url).includes('/ghost.png')
      ? new Response('nope', { status: 404 })
      : new Response(png, { headers: { 'content-type': 'image/png' } });
  });
  try {
    assert.equal(await a.get('evil.example', 'bob'), null, 'unknown host is never fetched');
    assert.equal(await a.get('github.com', '../etc'), null, 'not a login');
    assert.deepEqual((await a.get('github.com', 'bob'))?.body, png);
    assert.deepEqual((await a.get('github.com', 'bob'))?.body, png);
    assert.equal(calls, 1, 'second read came from disk');
    assert.equal(await a.get('github.com', 'ghost'), null);
    assert.equal(await a.get('github.com', 'ghost'), null);
    assert.equal(calls, 2, 'misses are remembered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
