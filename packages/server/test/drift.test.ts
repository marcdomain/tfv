// Scheduler end to end: real git (blobless clone + blame), real SQLite, a fake
// terraform replaying a real refresh-only plan, and captured chat requests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DriftScheduler } from '../src/drift.ts';
import { Store } from '../src/store.ts';
import { parseServerPolicy, type ServerConfig } from '../src/config.ts';
import type { ToolResolver } from '../src/runner.ts';
import type { Repo } from '../src/vcs/types.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
let tmp: string;
let origin: string;
let store: Store;
let sent: { url: string; body: any }[];
let mode: 'drift' | 'clean' | 'broken' | 'update';
let drift: DriftScheduler;

const FAKE_TF = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const F = ${JSON.stringify(FIXTURES)};
const mode = process.env.FAKE_MODE;
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'init') process.exit(0);
if (cmd === 'plan') {
  if (mode === 'broken') { console.error('Error: No valid credential sources found'); process.exit(1); }
  if (!rest.includes('-lock=false')) { console.error('drift plans must not lock'); process.exit(1); }
  const refresh = rest.includes('-refresh-only');
  const out = rest.find(a => a.startsWith('-out=')).slice(5);
  const drifted = refresh && (mode === 'drift' || mode === 'update');
  fs.writeFileSync(out, drifted ? mode : 'clean');
  process.exit(drifted ? 2 : 0);
}
if (cmd === 'show') {
  const kind = fs.readFileSync(rest[rest.length - 1], 'utf-8');
  process.stdout.write(fs.readFileSync(path.join(F, kind === 'drift' ? 'plan-drift.json' : kind === 'update' ? 'plan-drift-update.json' : 'plan-nochange.json')));
  process.exit(0);
}
process.exit(1);
`;

const sh = (args: string[], name = 'Alice Okafor', email = 'alice@acme.dev') =>
  execFileSync('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, ...args], { cwd: origin, encoding: 'utf-8' });

const repo: Repo = { platform: 'github', host: 'github.com', owner: 'acme', name: 'infra', fullName: 'acme/infra', cloneUrl: '', defaultBranch: 'main', installationId: 1 };

const REPO_TERIAC_YAML = `
drift:
  - name: from-repo
    projects: ["envs/*"]
    schedule: "15 * * * *"
    notify: [alerts]
  - name: bad-channel
    projects: ["envs/*"]
    schedule: "0 * * * *"
    notify: [nope]
`;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'teriac-drift-'));
  origin = join(tmp, 'origin');
  mkdirSync(join(origin, 'envs/prod'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: origin });
  execFileSync('git', ['config', 'uploadpack.allowFilter', 'true'], { cwd: origin });
  writeFileSync(join(origin, 'envs/prod/main.tf'),
    'resource "local_file" "app_config" {\n  filename = "a"\n  content  = "1"\n}\n\nresource "local_file" "motd" {\n  filename = "b"\n  content  = "hi"\n}\n');
  sh(['add', '-A']);
  sh(['commit', '-qm', 'Add prod files']);
  writeFileSync(join(origin, 'envs/prod/main.tf'),
    'resource "local_file" "app_config" {\n  filename = "a"\n  content  = "1"\n}\n\nresource "local_file" "motd" {\n  filename = "b"\n  content  = "maintenance"\n}\n');
  sh(['commit', '-qam', 'Update motd'], 'Bob Martins', '4821+bob-m@users.noreply.github.com');

  const fakeTf = join(tmp, 'terraform');
  writeFileSync(fakeTf, FAKE_TF);
  chmodSync(fakeTf, 0o755);
  const resolver: ToolResolver = { resolve: async () => ({ tool: { provider: 'terraform', version: '1.9.8', binary: fakeTf } }) };

  const policy = parseServerPolicy(`
channels:
  alerts: { type: slack, channel: C1, token_env: SLACK }
people:
  - { name: Bob Martins, github: bob-m, slack: U04BOBM }
repos:
  - id: github.com/acme/infra
    drift:
      - name: nightly
        projects: [envs/prod]
        schedule: "0 6 * * 1-5"
        timezone: Europe/Madrid
        notify: [alerts]
      - name: fixer
        projects: [envs/prod]
        schedule: "30 6 * * *"
        notify: [alerts]
        fix_pr: true
`);
  const config: ServerConfig = {
    port: 0, dataDir: join(tmp, 'data'), publicUrl: 'https://teriac.example.com', parallelism: 2, runTimeoutMs: 60_000,
    commandNames: ['teriac'], defaultVersion: 'latest', requireApplyProject: false, ackReaction: 'eyes', progressReply: true, commentMode: 'update', spinnerUrl: null, auth: { sessionSecret: 'x'.repeat(32), sessionHours: 1, secureCookies: false, users: [] }, ...policy,
  };
  store = new Store(':memory:');
  sent = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).includes('lookupByEmail')) return new Response('{"ok":false}');
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('{"ok":true}');
  };
  const adapter: any = {
    platform: 'github',
    listRepos: async () => [repo, { ...repo, fullName: 'stranger/repo', owner: 'stranger', name: 'repo' }],
    fileAt: async (_r: Repo, f: string) => (f === 'teriac.yaml' ? REPO_TERIAC_YAML : null),
    cloneAuth: async () => ({ url: origin }),
    openPullRequest: async (_r: Repo, p: any) => { opened.push(p); return opened.length === 1 ? 'https://github.com/acme/infra/pull/77' : null; },
  };
  drift = new DriftScheduler({
    config, store, adapters: [adapter], resolver, limited: <T>(fn: () => Promise<T>) => fn(), fetchImpl,
    get env() { return { PATH: process.env.PATH, HOME: process.env.HOME, SLACK: 'xoxb-test', FAKE_MODE: mode }; },
  } as any);
});

after(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const nightly = () => drift.schedules.find(e => e.spec.name === 'nightly')!;
const opened: any[] = [];

test('loads server and repo schedules; skips unknown channels and unlisted repos', async () => {
  await drift.refresh();
  assert.deepEqual(drift.schedules.map(e => e.key).sort(), [
    'repo:github.com/acme/infra:main:from-repo',
    'server:github.com/acme/infra:main:fixer',
    'server:github.com/acme/infra:main:nightly',
  ]);
  assert.equal(drift.next(nightly(), new Date('2026-11-07T20:00:00Z'))?.toISOString(), '2026-11-09T05:00:00.000Z');
});

test('fires on schedule, once per minute, and tags who changed each resource', async () => {
  mode = 'drift';
  const monday = new Date('2026-11-09T05:00:00Z');
  const runs = drift.tick(monday).filter(Boolean);
  assert.equal(runs.length, 1, 'only the nightly schedule matches 05:00 UTC');
  const result = await runs[0];
  assert.equal(drift.tick(monday).length, 0, 'same minute is not run twice');

  const p = result!.report.projects[0];
  assert.deepEqual(p.drift.map(d => [d.address, d.author?.name]), [
    ['local_file.app_config', 'Alice Okafor'],
    ['local_file.motd', 'Bob Martins'],
  ]);
  assert.deepEqual(result!.notified, [{ channel: 'alerts', ok: true }]);
  const text = JSON.stringify(sent[0].body.blocks);
  assert.match(text, /local_file.motd` deleted outside Terraform · last changed by <@U04BOBM>/);
  assert.match(text, /local_file.app_config` deleted outside Terraform · last changed by \*Alice Okafor\*/);
});

test('the same drift again stays quiet; a fix and new drift notify', async () => {
  sent.length = 0;
  assert.equal((await drift.run(nightly())).notified, null);
  mode = 'clean';
  assert.equal((await drift.run(nightly())).notified, null, 'clean runs are quiet');
  mode = 'drift';
  assert.notEqual((await drift.run(nightly())).notified, null, 'drift came back');
  assert.equal(sent.length, 1);
});

test('errors are reported to the channel', async () => {
  sent.length = 0;
  mode = 'broken';
  const r = await drift.run(nightly());
  assert.match(r.report.projects[0].error!, /No valid credential sources/);
  assert.match(JSON.stringify(sent[0].body), /Drift check failed in acme\/infra/);
  const history = store.recentDrift(10) as { status: string }[];
  assert.equal(history[0].status, 'error');
});

test('fix_pr: a PR updates plain values in the code; the notification links it; a second run does not duplicate it', async () => {
  sent.length = 0;
  mode = 'update';
  const fixer = drift.schedules.find(e => e.spec.name === 'fixer')!;
  const r = await drift.run(fixer);
  const p = r.report.projects[0];
  assert.equal(p.fixPr, 'https://github.com/acme/infra/pull/77');
  assert.equal(opened.length, 1);
  assert.deepEqual([opened[0].base, opened[0].branch, opened[0].title], ['main', 'teriac/drift-fix/envs_prod', 'Accept drift in envs/prod']);
  assert.equal(opened[0].files.length, 1);
  assert.match(opened[0].files[0].content, /content  = "all systems go"/);
  assert.match(opened[0].files[0].content, /content  = "1"/, 'only the drifted value changes');
  assert.match(opened[0].body, /`local_file\.motd` · `content`: "maintenance" → "all systems go"/);
  assert.match(opened[0].body, /`local_file\.app_config`: deleted outside Terraform/);
  assert.match(JSON.stringify(sent[0].body), /<https:\/\/github\.com\/acme\/infra\/pull\/77\|Fix PR>/);
  assert.ok(store.auditLog(5).some(a => a.action === 'drift_fix_pr' && /opened/.test(a.reason)));
  const again = await drift.run(fixer);
  assert.match(again.report.projects[0].fixNote ?? '', /already open \(branch `teriac\/drift-fix\/envs_prod`\)/);
});

test('fix_pr off (the default): no PR', async () => {
  const before = opened.length;
  mode = 'update';
  await drift.run(nightly());
  assert.equal(opened.length, before);
});
