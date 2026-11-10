import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPerson, githubLoginFromEmail, peopleFor, sendReport, notifyAll, teamsMessage, type DriftReport } from '../src/notify.ts';
import type { Person } from '../src/config.ts';

const people: Person[] = [
  { name: 'Alice Okafor', emails: ['alice@acme.dev'], teams: 'alice@acme.onmicrosoft.com', discord: '111' },
  { name: 'Bob Martins', github: 'bob-m', slack: 'U04BOBM' },
];

const author = (name: string, email: string, sha: string) => ({ name, email, sha, date: '', subject: 'msg', via: 'resource' as const });
const report: DriftReport = {
  repo: 'acme/infra', host: 'github.com', branch: 'main', sha: 'abcdef1234', schedule: 'prod-nightly', cleanCount: 2, url: 'https://teriac.acme.dev/',
  projects: [{
    project: 'envs/prod', engine: 'terraform 1.9.8',
    drift: [
      { address: 'aws_s3_bucket.logs', action: 'update', author: author('Alice Okafor', 'alice@acme.dev', '05e83d1aaa') },
      { address: 'aws_iam_role.app', action: 'delete', author: author('Bob Martins', '4821+bob-m@users.noreply.github.com', '20176ddbbb') },
    ],
    pending: { add: 1, change: 0, destroy: 0, replace: 0 },
    lastApply: { user: 'bob-m', pr: 37, at: '' },
  }],
};

const capture = () => {
  const calls: { url: string; body: any; headers: any }[] = [];
  const f: typeof fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('lookupByEmail')) return new Response(JSON.stringify({ ok: true, user: { id: 'U_LOOKED_UP' } }));
    calls.push({ url: u, body: JSON.parse(String(init?.body)), headers: init?.headers });
    return new Response('{"ok":true}');
  };
  return { calls, f };
};

test('identities: emails, GitHub logins and noreply addresses', () => {
  assert.equal(githubLoginFromEmail('4821+bob-m@users.noreply.github.com'), 'bob-m');
  assert.equal(githubLoginFromEmail('bob-m@users.noreply.github.com'), 'bob-m');
  assert.equal(githubLoginFromEmail('bob@acme.dev'), undefined);
  assert.equal(findPerson(people, { name: 'x', email: 'ALICE@acme.dev' })?.name, 'Alice Okafor');
  assert.equal(findPerson(people, { name: 'x', email: '4821+bob-m@users.noreply.github.com' })?.name, 'Bob Martins');
  assert.equal(findPerson(people, { name: 'x', github: 'BOB-M' })?.name, 'Bob Martins');
  assert.deepEqual(peopleFor(report.projects[0]).map(p => p.name), ['Alice Okafor', 'Bob Martins', 'bob-m']);
});

test('Slack (bot token): mentions by table or email lookup, token as header', async () => {
  const { calls, f } = capture();
  await sendReport('alerts', { type: 'slack', channel: 'C123', token_env: 'SLACK' }, report, { people, env: { SLACK: 'xoxb-test-token' }, fetchImpl: f });
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(calls[0].headers.Authorization, 'Bearer xoxb-test-token');
  assert.equal(calls[0].body.channel, 'C123');
  const text = JSON.stringify(calls[0].body.blocks);
  assert.match(text, /aws_s3_bucket.logs` changed outside Terraform · last changed by <@U_LOOKED_UP>/);
  assert.match(text, /aws_iam_role.app` deleted outside Terraform · last changed by <@U04BOBM>/);
  assert.match(text, /Merged but not applied: 1 to add/);
  assert.match(text, /Last applied by <@U04BOBM> via PR #37/);
  assert.match(text, /2 other projects clean/);
});

test('Teams: Adaptive Card with real mention entities', () => {
  const msg = teamsMessage(report, people) as any;
  const card = msg.attachments[0].content;
  assert.equal(msg.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.deepEqual(card.msteams.entities.map((e: any) => e.mentioned.id), ['alice@acme.onmicrosoft.com']);
  // Bob has no Teams identity or email: named in bold, not a broken mention.
  assert.match(JSON.stringify(card.body), /\*\*Bob Martins\*\*/);
});

test('Discord only pings mapped users; Google Chat and webhooks get text/JSON', async () => {
  const { calls, f } = capture();
  const env = { HOOK: 'https://hooks.example/x' };
  await sendReport('d', { type: 'discord', webhook_url_env: 'HOOK' }, report, { people, env, fetchImpl: f });
  assert.deepEqual(calls[0].body.allowed_mentions, { users: ['111'] });
  assert.match(calls[0].body.content, /<@111>/);
  await sendReport('g', { type: 'googlechat', webhook_url_env: 'HOOK' }, report, { people, env, fetchImpl: f });
  assert.match(calls[1].body.text, /\*Drift detected in acme\/infra/);
  await sendReport('w', { type: 'webhook', webhook_url_env: 'HOOK' }, report, { people, env, fetchImpl: f });
  assert.equal(calls[2].body.event, 'teriac.drift');
  assert.equal(calls[2].body.people[0].people[0].person.name, 'Alice Okafor');
});

test('a failing channel is reported, and the others still send', async () => {
  const { calls, f } = capture();
  const results = await notifyAll(['missing-env', 'ok'], {
    'missing-env': { type: 'teams', webhook_url_env: 'NOT_SET' },
    ok: { type: 'webhook', webhook_url_env: 'HOOK' },
  }, report, { people, env: { HOOK: 'https://hooks.example/x' }, fetchImpl: f });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error!, /NOT_SET is empty/);
  assert.equal(results[1].ok, true);
  assert.equal(calls.length, 1);
});
