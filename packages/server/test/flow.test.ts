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
  comments: { id: string; pr: number; body: string }[] = [];
  private seq = 0;
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
  async upsertComment(_r: Repo, n: number, _m: string, body: string) { this.sticky.set(n, body); return { id: `s${n}`, url: `https://github.test/pr/${n}#summary` }; }
  async comment(_r: Repo, n: number, body: string) { const id = String(++this.seq); this.comments.push({ id, pr: n, body }); return id; }
  async editComment(_r: Repo, id: string, body: string) { const c = this.comments.find(x => x.id === id); if (c) c.body = body; }
  reactions: string[] = [];
  async react(_r: Repo, _n: number, _c: string, reaction: string) { this.reactions.push(reaction); }
  async setCheck(_r: Repo, c: CheckRun) { this.checks.set(c.name, c); return `https://github.test/runs/${encodeURIComponent(c.name)}`; }
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
    commandNames: ['tfv'], defaultVersion: 'latest', requireApplyProject: false, ackReaction: 'eyes', progressReply: true, commentMode: 'update', spinnerUrl: 'https://tfv.example.com/assets/spinner.gif', auth: { sessionSecret: 'x'.repeat(32), sessionHours: 1, secureCookies: false, users: [] }, channels: {}, people: [],
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
  assert.match(body, /\| \[`envs\/dev`\]\([^)]+\) \| terraform 1\.9\.8 \| terraform \(built-in\) \| ⚠️ \*\*\+3 ~1 ±1 −1\*\* \| 🔒 1 more approval from write \|/);
  assert.match(body, /\| \[`envs\/prod`\]\([^)]+\) \|.*\| 🔒 1 more approval from team:platform-admins \|/);
  // Rich parts: counts, who ran it (avatar + profile link, no @mention), next steps.
  assert.match(body, /<sub>⚠️ 4 to destroy or replace · 🔒 2 waiting<\/sub>/);
  assert.match(body, /\| <img src="https:\/\/github\.com\/bob\.png\?size=36" width="18" height="18" align="center" alt=""> \[bob\]\(https:\/\/github\.com\/bob\) \|/);
  assert.doesNotMatch(body, /@bob/);
  assert.match(body, /\*\*Next steps\*\*\n- 🔒 \*\*`envs\/dev`\*\* needs 1 more approval from write\n- 🔒 \*\*`envs\/prod`\*\* needs 1 more approval from team:platform-admins/);
  assert.match(body, /\[Open in the tfv dashboard\]\(https:\/\/tfv\.example\.com\/#runs\/\d+\)/);
  const check = gh.checks.get('tfv: envs/prod')!;
  assert.equal(check.conclusion, 'neutral');
  assert.equal(check.actions?.[0].identifier, 'apply');
  assert.equal(store.locksForPr('github.com/acme/infra', 1).length, 2);
});

test('2. apply without approvals is refused with reasons', async () => {
  await comment(1, 'bob', 'tfv apply');
  const reply = gh.lastReply();
  assert.match(reply, /\*\*Not applied:\*\*/);
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
  assert.match(gh.sticky.get(1)!, /\| \[`envs\/dev`\]\([^)]+\) \|.*\| ✅ applied \|/);
  assert.match(gh.sticky.get(1)!, /\*\*Approved by\*\* <img src="https:\/\/github\.com\/carol\.png\?size=36"[^>]*> \[carol\]\(https:\/\/github\.com\/carol\)/);
  assert.match(gh.sticky.get(1)!, /- 🟢 \*\*`envs\/prod`\*\* is ready\. Comment this[^\n]*:\n  ```\n  tfv apply -p envs\/prod\n  ```/);
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
  assert.match(gh.sticky.get(2)!, /\| \[`envs\/dev`\]\([^)]+\) \| terraform 1\.9\.8 \| terraform \(built-in\) \| ⚠️/);
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
  assert.match(reply, /```\ntfv apply -p envs\/dev\n```\n\n```\ntfv apply -p envs\/prod\n```/);
  assert.equal(store.latestRuns('github.com/acme/infra', 9, 'apply').length, 0);
  assert.match(gh.sticky.get(9)!, /Apply one project at a time: `tfv apply -p <project>`/);

  await strict.handle(gh, { kind: 'comment', repo, prNumber: 9, commentId: '10', author: 'bob', body: 'tfv plan -p envs/dev -t terraform_data.cdn -t terraform_data.worker[0]' });
  const dev = store.latestRuns('github.com/acme/infra', 9, 'plan').find(r => r.project === 'envs/dev')!;
  assert.deepEqual(dev.targets, ['terraform_data.cdn', 'terraform_data.worker[0]']);
  assert.match(dev.output, /ARGS .*-target=terraform_data\.cdn -target=terraform_data\.worker\[0\]/);
  const body = gh.sticky.get(9)!;
  assert.match(body, /\| \[`envs\/dev`\]\([^)]+\) \|.*🎯 targeted \|/);
  assert.match(body, /\[!NOTE\]\n> \*\*Targeted plan:\*\* only `terraform_data.cdn`, `terraform_data.worker\[0\]`/);
});

test('10. the pick-up reaction: eyes by default, configurable per repo, or off', async () => {
  const before = gh.reactions.length;
  await comment(2, 'carol', 'tfv help');
  assert.equal(gh.reactions[before], 'eyes');
  const mk = (ack: string) => new App({
    config: { ...(app as any).deps.config, repos: parseReposYaml(`repos:\n  - id: github.com/acme/*\n    ack_reaction: ${ack}\n`) },
    store, resolver: (app as any).deps.resolver,
  });
  await mk('rocket').handle(gh, { kind: 'comment', repo, prNumber: 2, commentId: '11', author: 'carol', body: 'tfv help' });
  assert.equal(gh.reactions.at(-1), 'rocket');
  const n = gh.reactions.length;
  await mk('none').handle(gh, { kind: 'comment', repo, prNumber: 2, commentId: '12', author: 'carol', body: 'tfv help' });
  assert.equal(gh.reactions.length, n, 'no reaction when turned off');
  assert.throws(() => parseReposYaml('repos:\n  - id: x\n    ack_reaction: thumbsup\n'), /ack_reaction must be one of eyes, rocket/);
});

test('11. defaults: ⏳ reply at once, then a NEW comment per plan with apply commands and ▶ Apply links', async () => {
  const fresh = new App({
    config: { ...(app as any).deps.config, ackReaction: 'eyes', progressReply: true, commentMode: 'new' },
    store, resolver: (app as any).deps.resolver,
  });
  await app.handle(gh, { kind: 'pr_closed', repo, pr: pr(9, 'bob'), merged: false }); // release #9's locks
  gh.prs.set(20, pr(20, 'bob'));
  gh.files.set(20, ['envs/dev/main.tf', 'envs/prod/main.tf']);
  gh.reviewsByPr.set(20, [{ user: 'carol', state: 'approved', commitSha: head }]);
  const mine = () => gh.comments.filter(c => c.pr === 20);

  await fresh.handle(gh, { kind: 'pr_opened', repo, pr: pr(20, 'bob') });
  assert.equal(gh.sticky.get(20), undefined, 'no comment edited at the top');
  assert.equal(mine().length, 1);
  const first = mine()[0].body;
  assert.doesNotMatch(first, /spinner\.gif/, 'the spinning reply was turned into the report');
  assert.match(first, /\| Project \| Engine \| Providers \| Plan \| Apply \| By \|/);
  assert.match(first, /\*\*To apply:\*\* comment this, or \[\*\*▶ Apply\*\*\]\(https:\/\/github\.test\/runs\/tfv%3A%20envs%2Fdev\):\n```\ntfv apply -p envs\/dev\n```/);
  assert.match(first, /- 🟢 \*\*`envs\/prod`\*\* is ready\. Comment this, or \[\*\*▶ Apply\*\*\]\([^)]+\):\n  ```\n  tfv apply -p envs\/prod\n  ```/);

  // While a command runs, its reply says so; afterwards it holds that command's report.
  let during = '';
  const realEdit = gh.editComment.bind(gh);
  gh.editComment = async (r, id, body) => { during = gh.comments.find(c => c.id === id)!.body; return realEdit(r, id, body); };
  await fresh.handle(gh, { kind: 'comment', repo, prNumber: 20, commentId: '20', author: 'bob', body: 'tfv plan -p envs/dev' });
  gh.editComment = realEdit;
  assert.equal(during, '<img src="https://tfv.example.com/assets/spinner.gif" width="16" height="16" align="center" alt="👀"> Running `tfv plan -p envs/dev` for bob…');
  assert.equal(mine().length, 2, 'a new comment for the new plan');
  assert.match(mine()[1].body, /`envs\/dev`/);
  assert.doesNotMatch(mine()[1].body, /`envs\/prod`/, 'only the projects this command planned');
  assert.equal(mine()[0].body, first, 'the earlier report is left as it was');
});

test('12. a spinning reply always resolves, even when every project is locked', async () => {
  const fresh = new App({ config: { ...(app as any).deps.config, ackReaction: 'eyes', progressReply: true, commentMode: 'new' }, store, resolver: (app as any).deps.resolver });
  gh.prs.set(21, pr(21, 'carol'));
  gh.files.set(21, ['envs/dev/main.tf']);
  await fresh.handle(gh, { kind: 'pr_opened', repo, pr: pr(21, 'carol') }); // #20 holds envs/dev
  const body = gh.comments.filter(c => c.pr === 21).at(-1)!.body;
  assert.doesNotMatch(body, /spinner\.gif/);
  assert.match(body, /`envs\/dev`: 🔒 locked by #20/);
});

test('13. no public https address for the spinner: just the 👀 reaction, then the result', async () => {
  const noSpin = new App({ config: { ...(app as any).deps.config, ackReaction: 'eyes', progressReply: true, commentMode: 'new', spinnerUrl: null }, store, resolver: (app as any).deps.resolver });
  const reactions = gh.reactions.length;
  const comments = gh.comments.length;
  await noSpin.handle(gh, { kind: 'comment', repo, prNumber: 21, commentId: '30', author: 'carol', body: 'tfv unlock' });
  assert.equal(gh.reactions[reactions], 'eyes');
  assert.equal(gh.comments.length, comments + 1, 'just the result, no "Running…" reply');
  assert.doesNotMatch(gh.comments.at(-1)!.body, /spinner/);
});

test('14. defaults together: 👀 on the command AND a spinning reply under it', async () => {
  const both = new App({ config: { ...(app as any).deps.config, ackReaction: 'eyes', progressReply: true, commentMode: 'new' }, store, resolver: (app as any).deps.resolver });
  const r = gh.reactions.length;
  let first = '';
  const realComment = gh.comment.bind(gh);
  gh.comment = async (rp, n, body) => { if (!first) first = body; return realComment(rp, n, body); };
  await both.handle(gh, { kind: 'comment', repo, prNumber: 21, commentId: '40', author: 'carol', body: 'tfv unlock' });
  gh.comment = realComment;
  assert.equal(gh.reactions[r], 'eyes');
  assert.match(first, /^<img src="https:\/\/tfv\.example\.com\/assets\/spinner\.gif"[^>]*alt="👀"> Running `tfv unlock` for carol…$/);
});

test('15. policy checks (enforce + override) and the two-person rule', async () => {
  await app.handle(gh, { kind: 'pr_closed', repo, pr: pr(20, 'bob'), merged: false }); // free envs/dev, envs/prod
  const strict = new App({
    config: {
      ...(app as any).deps.config, commentMode: 'update',
      repos: parseReposYaml('repos:\n  - id: github.com/acme/*\n    two_person_rule: true\n    projects:\n      - match: "**"\n        permissions: { apply_destroy: [write] }\n'),
      policies: {
        mode: 'enforce', override: ['team:platform-admins'],
        rules: [{ name: 'no-prod-destroy', projects: ['envs/prod'], actions: ['delete', 'replace'], message: 'needs a security override' }],
      },
    },
    store, resolver: (app as any).deps.resolver,
  });
  gh.prs.set(30, pr(30, 'alice'));
  gh.files.set(30, ['envs/prod/main.tf']);
  await strict.handle(gh, { kind: 'pr_opened', repo, pr: pr(30, 'alice') });
  const body = gh.sticky.get(30)!;
  assert.match(body, /🛡️ 2 policy findings/);
  assert.match(body, /🛡️ \*\*Policy \(enforced: blocks apply\):\*\* 2 findings/);
  assert.match(body, /🔴 \*\*no-prod-destroy\*\* · `terraform_data\.database` · needs a security override/);
  assert.match(body, /\*\*To apply \(someone other than alice\):\*\* first 2 policy findings \(no-prod-destroy\)\. Then comment:\n```\ntfv apply -p envs\/prod\n```/);

  const say = async (user: string, text: string) => {
    await strict.handle(gh, { kind: 'comment', repo, prNumber: 30, commentId: String(Math.random()), author: user, body: text });
    return gh.lastReply();
  };
  assert.match(await say('alice', 'tfv apply -p envs/prod'), /two-person rule: someone other than the PR author \(alice\) must apply/);
  assert.match(await say('erin', 'tfv apply -p envs/prod'), /2 policy findings \(no-prod-destroy\)/);
  assert.match(await say('erin', 'tfv apply -p envs/prod --override'), /`--override` needs team:platform-admins/);
  await say('carol', 'tfv apply -p envs/prod --override'); // platform-admins team member
  const applied = store.latestRuns('github.com/acme/infra', 30, 'apply');
  assert.deepEqual(applied.map(r => [r.project, r.status, r.user]), [['envs/prod', 'success', 'carol']]);

  const overrides = store.auditLog(50).filter(a => a.action === 'override' && a.pr === 30);
  assert.deepEqual(overrides.map(a => [a.user, a.allowed]), [['carol', true], ['erin', false]]);
  const found = store.searchFindings({ project: 'envs/prod', rule: 'no-prod-destroy' });
  assert.ok(found.total >= 2);
  assert.equal(found.items[0].mode, 'enforce');
});

test('16. audit mode reports findings without blocking', async () => {
  await app.handle(gh, { kind: 'pr_closed', repo, pr: pr(30, 'alice'), merged: false });
  const audit = new App({
    config: {
      ...(app as any).deps.config, commentMode: 'update',
      repos: parseReposYaml('repos:\n  - id: github.com/acme/*\n'),
      policies: { mode: 'audit', rules: [{ name: 'no-destroy', actions: ['delete'] }] },
    },
    store, resolver: (app as any).deps.resolver,
  });
  gh.prs.set(31, pr(31, 'bob'));
  gh.files.set(31, ['envs/dev/main.tf']);
  await audit.handle(gh, { kind: 'pr_opened', repo, pr: pr(31, 'bob') });
  const body = gh.sticky.get(31)!;
  assert.match(body, /🛡️ \*\*Policy \(audit: not blocking\):\*\* 1 finding/);
  assert.match(body, /\| 🟢 ready/);
});

test('someone edits or deletes a tfv comment: left as is; warning links to it with the original; audited', async () => {
  await comment(1, 'bob', 'tfv plan -p envs/dev');
  const mine = gh.comments.filter(c => c.pr === 1 && c.body.includes('envs/dev')).at(-1)!;
  const original = mine.body;
  // A user with write access rewrites tfv's comment to hide the destroy.
  mine.body = 'No changes 🙂';
  await app.handle(gh, { kind: 'bot_comment_changed', repo, prNumber: 1, commentId: mine.id, by: 'mallory', change: 'edited', body: 'No changes 🙂' });
  assert.equal(mine.body, 'No changes 🙂', 'not restored');
  const warning = gh.comments.at(-1)!.body;
  assert.match(warning, new RegExp(`\\*\\*\\[tfv's comment\\]\\(https://github\\.com/acme/infra/pull/1#issuecomment-${mine.id}\\) was edited by mallory\\.\\*\\*`));
  assert.match(warning, /<details><summary>View the original<\/summary>/);
  assert.ok(warning.includes(original.replace(/<!--\s*tfv:[^>]*-->\n?/g, '')), 'carries the original');
  assert.doesNotMatch(warning, /<!-- tfv:/, 'no hidden markers in the copy');
  // Deleted.
  await app.handle(gh, { kind: 'bot_comment_changed', repo, prNumber: 1, commentId: mine.id, by: 'mallory', change: 'deleted', body: '' });
  assert.match(gh.comments.at(-1)!.body, /A tfv comment was deleted by mallory[\s\S]*View the original/);
  const actions = store.searchAudit({}).items.map(a => a.action);
  assert.ok(actions.includes('comment_edited') && actions.includes('comment_deleted'));
  // A comment tfv didn't write: left alone.
  const before = gh.comments.length;
  await app.handle(gh, { kind: 'bot_comment_changed', repo, prNumber: 1, commentId: 'not-ours', by: 'x', change: 'edited', body: '' });
  assert.equal(gh.comments.length, before);
});
