// End-to-end flow: real git checkouts, real SQLite, real rendering and RBAC;
// a fake `terraform` replays real plan output so no cloud access is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, MARKER } from '../src/app.ts';
import { Store } from '../src/store.ts';
import { parseReposYaml, type ServerConfig } from '../src/config.ts';
import type { ToolResolver } from '../src/runner.ts';
import type { CheckRun, Permission, PullRequestState, Repo, Review, VcsAdapter, VcsEvent } from '../src/vcs/types.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
let tmp: string;
let origin: string;
let head: string;
let store: Store;
let app: App;
let gh: FakeGitHub;

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

// Fake terraform: replays real plan output from the fixtures.
const FAKE_TF = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const F = ${JSON.stringify(FIXTURES)};
const [cmd, ...rest] = process.argv.slice(2);
const noop = fs.existsSync('NO_CHANGES');
if (cmd === 'init') { console.log('Terraform has been successfully initialized!'); process.exit(0); }
if (cmd === 'plan') {
  const out = rest.find(a => a.startsWith('-out=')).slice(5);
  fs.writeFileSync(out, noop ? 'noop' : 'changes');
  console.log('ARGS ' + rest.join(' '));
  process.stdout.write(fs.readFileSync(path.join(F, noop ? 'plan-nochange.txt' : 'plan-changes.txt')));
  process.exit(noop ? 0 : 2);
}
if (cmd === 'show') {
  const plan = fs.readFileSync(rest[rest.length - 1], 'utf-8');
  process.stdout.write(fs.readFileSync(path.join(F, plan === 'noop' ? 'plan-nochange.json' : 'plan-changes.json')));
  process.exit(0);
}
if (cmd === 'apply') {
  if (process.env.TFV_GITHUB_PRIVATE_KEY) { console.log('LEAK'); }
  console.log('Apply complete! Resources: 3 added, 1 changed, 2 destroyed.'); process.exit(0);
}
process.exit(1);
`;

const PERMS: Record<string, Permission> = { bob: 'write', carol: 'write', erin: 'maintain', alice: 'admin', mallory: 'none' };
const TEAMS: Record<string, string[]> = { 'platform-admins': ['alice', 'carol'] };

class FakeGitHub implements VcsAdapter {
  readonly platform = 'github' as const;
  readonly commentLimit = 65000;
  readonly supportsChecks = true;
  comments: { pr: number; body: string }[] = [];
  sticky = new Map<number, string>();
  checks = new Map<string, CheckRun>();
  reviewsByPr = new Map<number, Review[]>();
  prs = new Map<number, PullRequestState>();
  files = new Map<number, string[]>();

  verify() { return true; }
  parse(): VcsEvent { return { kind: 'ignored', reason: 'test' }; }
  async getPullRequest(_r: Repo, n: number) { return this.prs.get(n)!; }
  async changedFiles(_r: Repo, n: number) { return this.files.get(n) ?? []; }
  async cloneAuth() { return { url: origin }; }
  async upsertComment(_r: Repo, n: number, _m: string, body: string) { this.sticky.set(n, body); }
  async comment(_r: Repo, n: number, body: string) { this.comments.push({ pr: n, body }); }
  async react() {}
  async setCheck(_r: Repo, c: CheckRun) { this.checks.set(c.name, c); }
  async userPermission(_r: Repo, u: string) { return PERMS[u] ?? 'none'; }
  async inTeam(_r: Repo, t: string, u: string) { return (TEAMS[t] ?? []).includes(u); }
  async reviews(_r: Repo, n: number) { return this.reviewsByPr.get(n) ?? []; }
  async fileAt() { return null; }
  async codeowners() { return null; }
  async listRepos() { return []; }
  lastReply() { return this.comments[this.comments.length - 1]?.body ?? ''; }
}

const repo: Repo = { platform: 'github', host: 'github.com', owner: 'acme', name: 'infra', fullName: 'acme/infra', cloneUrl: '' };
const pr = (number: number, author: string): PullRequestState => ({
  number, title: 't', url: '', author, headSha: head, headRef: 'feat', baseRef: 'main',
  draft: false, fromFork: false, open: true, mergeable: true, behindBase: false,
});
const comment = (n: number, author: string, body: string) =>
  app.handle(gh, { kind: 'comment', repo, prNumber: n, commentId: '1', author, body });

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tfv-flow-'));
  origin = join(tmp, 'origin');
  mkdirSync(join(origin, 'envs/dev'), { recursive: true });
  mkdirSync(join(origin, 'envs/prod'), { recursive: true });
  writeFileSync(join(origin, 'envs/dev/main.tf'), 'resource "terraform_data" "x" {}\n');
  writeFileSync(join(origin, 'envs/prod/main.tf'), 'resource "terraform_data" "x" {}\n');
  sh(origin, 'init', '-q', '-b', 'main');
  sh(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  sh(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  sh(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  head = sh(origin, 'rev-parse', 'HEAD');

  const fakeTf = join(tmp, 'terraform');
  writeFileSync(fakeTf, FAKE_TF);
  chmodSync(fakeTf, 0o755);
  const resolver: ToolResolver = { resolve: async () => ({ tool: { provider: 'terraform', version: '1.9.8', binary: fakeTf } }) };

  const config: ServerConfig = {
    port: 0, dataDir: join(tmp, 'data'), publicUrl: 'https://tfv.example.com', parallelism: 2, runTimeoutMs: 60_000,
    commandNames: ['tfv', 'atlantis'], defaultVersion: 'latest', requireApplyProject: false, channels: {}, people: [],
    repos: parseReposYaml(`
repos:
  - id: github.com/acme/*
    apply_requirements: [mergeable]
    projects:
      - match: envs/prod
        permissions:
          apply: [team:platform-admins]
          apply_destroy: [team:platform-admins]
        approvals:
          - from: team:platform-admins
            count: 1
      - match: "**"
        approvals:
          - from: write
            count: 1
`),
  };
  store = new Store(':memory:');
  gh = new FakeGitHub();
  // A server secret in the env must never reach terraform.
  app = new App({ config, store, resolver, env: { ...process.env, TFV_GITHUB_PRIVATE_KEY: 'super-secret-key' } });
  gh.prs.set(1, pr(1, 'bob'));
  gh.files.set(1, ['envs/dev/main.tf', 'envs/prod/main.tf']);
});

after(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('1. push → autoplan both projects, sticky comment + checks with Apply buttons', async () => {
  await app.handle(gh, { kind: 'pr_opened', repo, pr: pr(1, 'bob') });
  const body = gh.sticky.get(1)!;
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /tfv · 2 projects/);
  assert.match(body, /\[!CAUTION\]/);
  assert.match(body, /\| `envs\/dev` \| terraform 1\.9\.8 \| ⚠️ \*\*\+3 ~1 ±1 −1\*\* \| 🔒 1 more approval from write \|/);
  assert.match(body, /\| `envs\/prod` \|.*\| 🔒 1 more approval from team:platform-admins \|/);
  const check = gh.checks.get('tfv: envs/prod')!;
  assert.equal(check.conclusion, 'neutral');
  assert.equal(check.actions?.[0].identifier, 'apply');
  assert.equal(store.locksForPr('github.com/acme/infra', 1).length, 2);
});

test('2. apply without approvals is refused with reasons', async () => {
  await comment(1, 'bob', 'tfv apply');
  const reply = gh.lastReply();
  assert.match(reply, /@bob these projects were not applied/);
  assert.match(reply, /`envs\/dev`: apply_destroy on `envs\/dev` needs maintain/);
  assert.match(reply, /`envs\/prod`: apply on `envs\/prod` needs team:platform-admins/);
  assert.equal(store.latestRuns('github.com/acme/infra', 1, 'apply').length, 0);
});

test('3. stale approvals do not count; fresh ones do', async () => {
  gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: 'an-older-commit' }]);
  await comment(1, 'erin', 'tfv apply -p envs/dev');
  assert.match(gh.lastReply(), /1 more approval from write/);

  gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }]);
  await comment(1, 'erin', 'tfv apply -p envs/dev');
  const applies = store.latestRuns('github.com/acme/infra', 1, 'apply');
  assert.deepEqual(applies.map(a => [a.project, a.status]), [['envs/dev', 'success']]);
  assert.doesNotMatch(applies[0].output, /LEAK/); // server secrets stripped from terraform's env
  assert.match(gh.sticky.get(1)!, /\| `envs\/dev` \|.*\| ✅ applied \|/);
});

test('4. Apply button on prod: a platform-admin applies after a team approval', async () => {
  // bob (write) presses Apply on prod: not on the team.
  await app.handle(gh, { kind: 'apply_button', repo, prNumber: 1, project: 'envs/prod', user: 'bob' });
  assert.match(gh.lastReply(), /apply on `envs\/prod` needs team:platform-admins/);
  // carol's approval of this commit is from the team, so alice can apply.
  await app.handle(gh, { kind: 'apply_button', repo, prNumber: 1, project: 'envs/prod', user: 'alice' });
  const applies = store.latestRuns('github.com/acme/infra', 1, 'apply');
  assert.deepEqual(applies.map(a => [a.project, a.status, a.user]), [['envs/dev', 'success', 'erin'], ['envs/prod', 'success', 'alice']]);
  assert.equal(gh.checks.get('tfv: envs/prod')!.title, 'Applied');
});

test('5. a second PR is blocked by the lock, and unblocked after merge', async () => {
  gh.prs.set(2, pr(2, 'carol'));
  gh.files.set(2, ['envs/dev/main.tf']);
  await app.handle(gh, { kind: 'pr_opened', repo, pr: pr(2, 'carol') });
  assert.match(gh.sticky.get(2)!, /locked by #1 \(bob\)/);

  await app.handle(gh, { kind: 'pr_closed', repo, pr: pr(1, 'bob'), merged: true });
  assert.equal(store.locksForPr('github.com/acme/infra', 1).length, 0);

  await comment(2, 'carol', 'tfv plan');
  assert.match(gh.sticky.get(2)!, /\| `envs\/dev` \| terraform 1\.9\.8 \| ⚠️/);
});

test('6. read-only users cannot run code; fork-style autoplan is held', async () => {
  gh.prs.set(3, pr(3, 'mallory'));
  gh.files.set(3, ['envs/prod/main.tf']);
  await app.handle(gh, { kind: 'pr_opened', repo, pr: pr(3, 'mallory') });
  assert.match(gh.sticky.get(3)!, /not planned automatically: plan on `envs\/prod` needs write/);
  assert.equal(store.latestRuns('github.com/acme/infra', 3, 'plan').length, 0);
  await comment(3, 'mallory', 'tfv plan');
  assert.match(gh.sticky.get(3)!, /🚫 plan on `envs\/prod` needs write/);
});

test('7. every decision is audited; unlock and help work', async () => {
  const audit = store.auditLog(500);
  assert.ok(audit.some(a => a.user === 'bob' && a.action === 'apply_destroy' && !a.allowed));
  assert.ok(audit.some(a => a.user === 'erin' && a.action === 'apply_destroy' && a.allowed));
  await comment(2, 'carol', 'tfv unlock');
  assert.match(gh.lastReply(), /Unlocked `envs\/dev`/);
  await comment(2, 'carol', 'tfv help');
  assert.match(gh.lastReply(), /### tfv commands/);
  await comment(2, 'carol', 'tfv destroy-everything');
  assert.match(gh.lastReply(), /Unknown command/);
});

test('8. closing a PR removes its checkout and plan files', async () => {
  await app.handle(gh, { kind: 'pr_closed', repo, pr: pr(2, 'carol'), merged: false });
  assert.equal(existsSync(join(tmp, 'data/work/github.com/acme/infra/2')), false);
  assert.equal(existsSync(join(tmp, 'data/plans/github.com/acme/infra/2')), false);
});

test('9. one project at a time: a bare apply is refused with exact commands; targets reach terraform', async () => {
  const strict = new App({
    config: { ...(app as any).deps.config, requireApplyProject: true },
    store, resolver: (app as any).deps.resolver, env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  gh.prs.set(9, pr(9, 'bob'));
  gh.files.set(9, ['envs/dev/main.tf', 'envs/prod/main.tf']);
  await strict.handle(gh, { kind: 'pr_opened', repo, pr: pr(9, 'bob') });

  await strict.handle(gh, { kind: 'comment', repo, prNumber: 9, commentId: '9', author: 'erin', body: 'tfv apply' });
  const reply = gh.lastReply();
  assert.match(reply, /applies one project at a time/);
  assert.match(reply, /- `tfv apply -p envs\/dev`\n- `tfv apply -p envs\/prod`/);
  assert.equal(store.latestRuns('github.com/acme/infra', 9, 'apply').length, 0);
  assert.match(gh.sticky.get(9)!, /Apply one project at a time: `tfv apply -p <project>`/);

  await strict.handle(gh, { kind: 'comment', repo, prNumber: 9, commentId: '10', author: 'bob', body: 'tfv plan -p envs/dev -t terraform_data.cdn -t terraform_data.worker[0]' });
  const dev = store.latestRuns('github.com/acme/infra', 9, 'plan').find(r => r.project === 'envs/dev')!;
  assert.deepEqual(dev.targets, ['terraform_data.cdn', 'terraform_data.worker[0]']);
  assert.match(dev.output, /ARGS .*-target=terraform_data\.cdn -target=terraform_data\.worker\[0\]/);
  const body = gh.sticky.get(9)!;
  assert.match(body, /\| `envs\/dev` \|.*🎯 targeted \|/);
  assert.match(body, /\[!NOTE\]\n> \*\*Targeted plan:\*\* only `terraform_data.cdn`, `terraform_data.worker\[0\]`/);
});
