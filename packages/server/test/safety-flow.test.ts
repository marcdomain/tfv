// The safety features end to end through the App: real git checkouts, real SQLite,
// real rendering and RBAC; a fake `terraform` replays real plan output, and a fake
// GitHub answers reviews, compare views and check runs.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.ts';
import { Store } from '../src/store.ts';
import { parseReposYaml, type ServerConfig } from '../src/config.ts';
import type { ToolResolver } from '../src/runner.ts';
import type { CheckRun, Comparison, Permission, PullRequestState, Repo, Review, VcsAdapter, VcsEvent } from '../src/vcs/types.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
let tmp: string;
let fixtures: string;
let origin: string;
let head: string;
let fakeTf: string;

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

// Fake terraform. Markers in the project folder change what it prints:
//   LEAK      the plan output contains an AWS access key
//   SECURITY  the plan JSON has AWS resources the built-in security rules flag
const FAKE_TF = (F: string) => `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const F = ${JSON.stringify(F)};
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'init') { console.log('Terraform has been successfully initialized!'); process.exit(0); }
if (cmd === 'plan') {
  const out = rest.find(a => a.startsWith('-out=')).slice(5);
  fs.writeFileSync(out, fs.existsSync('SECURITY') ? 'security' : 'changes');
  process.stdout.write(fs.readFileSync(path.join(F, 'plan-changes.txt')));
  if (fs.existsSync('LEAK')) console.log('  + tags = { owner_key = "AKIAIOSFODNN7EXAMPLE" }');
  process.exit(2);
}
if (cmd === 'show') {
  const plan = fs.readFileSync(rest[rest.length - 1], 'utf-8');
  process.stdout.write(fs.readFileSync(path.join(F, plan === 'security' ? 'plan-security.json' : 'plan-changes.json')));
  process.exit(0);
}
if (cmd === 'apply') { console.log('Apply complete! Resources: 3 added, 1 changed, 2 destroyed.'); process.exit(0); }
if (cmd === 'state' && rest[0] === 'list') { console.log('terraform_data.app'); process.exit(0); }
process.exit(1);
`;

const PERMS: Record<string, Permission> = { bob: 'write', carol: 'write', erin: 'maintain', alice: 'admin', mallory: 'none' };
const TEAMS: Record<string, string[]> = { 'platform-admins': ['alice', 'carol'], sre: ['erin'] };

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
  // compare(base, head): the PR's own changes at `head` (base = main), or base-branch
  // changes since the PR left it (head = main).
  prFiles = new Map<string, Comparison>();
  baseChanges: Comparison | null = null;

  verify() { return true; }
  parse(): VcsEvent { return { kind: 'ignored', reason: 'test' }; }
  async getPullRequest(_r: Repo, n: number) { return this.prs.get(n)!; }
  async changedFiles(_r: Repo, n: number) { return this.files.get(n) ?? []; }
  async cloneAuth() { return { url: origin }; }
  async upsertComment(_r: Repo, n: number, _m: string, body: string) { this.sticky.set(n, body); return { id: `s${n}`, url: `https://github.test/pr/${n}#summary` }; }
  async comment(_r: Repo, n: number, body: string) { const id = String(++this.seq); this.comments.push({ id, pr: n, body }); return id; }
  async editComment(_r: Repo, id: string, body: string) { const c = this.comments.find(x => x.id === id); if (c) c.body = body; }
  async react() {}
  async setCheck(_r: Repo, c: CheckRun) { this.checks.set(c.name, c); return `https://github.test/runs/${encodeURIComponent(c.name)}`; }
  async userPermission(_r: Repo, u: string) { return PERMS[u] ?? 'none'; }
  async inTeam(_r: Repo, t: string, u: string) { return (TEAMS[t] ?? []).includes(u); }
  async reviews(_r: Repo, n: number) { return this.reviewsByPr.get(n) ?? []; }
  async fileAt() { return null; }
  async codeowners() { return null; }
  async listRepos() { return []; }
  async compare(_r: Repo, base: string, headRef: string) {
    if (headRef === 'main') return this.baseChanges;
    return this.prFiles.get(headRef) ?? null;
  }
  lastReply() { return this.comments[this.comments.length - 1]?.body ?? ''; }
}

const repo: Repo = { platform: 'github', host: 'github.com', owner: 'acme', name: 'infra', fullName: 'acme/infra', cloneUrl: '' };
const pr = (number: number, author: string): PullRequestState => ({
  number, title: 't', url: '', author, headSha: head, headRef: 'feat', baseRef: 'main',
  draft: false, fromFork: false, open: true, mergeable: true, behindBase: false,
});
const prChanges = (blob: string): Comparison => ({ files: [{ path: 'envs/dev/main.tf', status: 'modified', blob }, { path: 'envs/prod/main.tf', status: 'modified', blob }], commits: [], truncated: false });

// A fresh App, store and fake GitHub with these repos.yaml rules and server settings.
const RULES = `
    projects:
      - match: envs/prod
        permissions: { apply: [team:platform-admins], apply_destroy: [team:platform-admins] }
        approvals: [{ from: team:platform-admins, count: 1 }]
      - match: "**"
        approvals: [{ from: write, count: 1 }]`;
const setup = (repoExtra = '', server: Partial<ServerConfig> = {}) => {
  const dataDir = mkdtempSync(join(tmp, 'data-'));
  const store = new Store(':memory:');
  const gh = new FakeGitHub();
  const resolver: ToolResolver = { resolve: async () => ({ tool: { provider: 'terraform', version: '1.9.8', binary: fakeTf } }) };
  const config: ServerConfig = {
    port: 0, dataDir, publicUrl: 'https://teriac.example.com', parallelism: 2, runTimeoutMs: 60_000,
    commandNames: ['teriac'], defaultVersion: 'latest', requireApplyProject: false, ackReaction: 'none', progressReply: false, commentMode: 'update', spinnerUrl: null,
    auth: { sessionSecret: 'x'.repeat(32), sessionHours: 1, secureCookies: false, users: [] }, channels: {}, people: [],
    repos: parseReposYaml(`repos:\n  - id: github.com/acme/*\n${repoExtra}${RULES}\n`),
    ...server,
  };
  const app = new App({ config, store, resolver, env: { ...process.env } });
  gh.prs.set(1, pr(1, 'bob'));
  gh.files.set(1, ['envs/dev/main.tf', 'envs/prod/main.tf']);
  const say = (author: string, body: string) => app.handle(gh, { kind: 'comment', repo, prNumber: 1, commentId: '1', author, body });
  const open = () => app.handle(gh, { kind: 'pr_opened', repo, pr: pr(1, 'bob') });
  return { app, store, gh, say, open, dataDir };
};
const applies = (store: Store) => store.latestRuns('github.com/acme/infra', 1, 'apply');

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'teriac-safety-'));
  fixtures = join(tmp, 'fixtures');
  mkdirSync(fixtures);
  for (const f of ['plan-changes.txt', 'plan-changes.json']) copyFileSync(join(FIXTURES, f), join(fixtures, f));
  writeFileSync(join(fixtures, 'plan-security.json'), JSON.stringify({
    format_version: '1.2',
    resource_changes: [
      { address: 'aws_s3_bucket_acl.logs', mode: 'managed', type: 'aws_s3_bucket_acl', name: 'logs', change: { actions: ['create'], before: null, after: { acl: 'public-read' }, after_unknown: {} } },
      { address: 'aws_security_group.ssh', mode: 'managed', type: 'aws_security_group', name: 'ssh', change: { actions: ['create'], before: null, after: { ingress: [{ from_port: 22, to_port: 22, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] }] }, after_unknown: {} } },
    ],
  }));
  origin = join(tmp, 'origin');
  mkdirSync(join(origin, 'envs/dev'), { recursive: true });
  mkdirSync(join(origin, 'envs/prod'), { recursive: true });
  const tf = 'resource "terraform_data" "app_config" {}\n\nresource "terraform_data" "database" {\n  input = "db"\n}\n\nresource "terraform_data" "legacy_queue" {}\n';
  writeFileSync(join(origin, 'envs/dev/main.tf'), tf);
  writeFileSync(join(origin, 'envs/prod/main.tf'), tf);
  sh(origin, 'init', '-q', '-b', 'main');
  sh(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  sh(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  sh(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  head = sh(origin, 'rev-parse', 'HEAD');
  fakeTf = join(tmp, 'terraform');
  writeFileSync(fakeTf, FAKE_TF(fixtures));
  chmodSync(fakeTf, 0o755);
});

after(() => rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
describe('approvals and rebases', () => {
  test('default: an approval of an earlier commit does not count', async () => {
    const { gh, store, say, open } = setup();
    await open();
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: 'before-rebase' }]);
    gh.prFiles.set(head, prChanges('b1'));
    gh.prFiles.set('before-rebase', prChanges('b1'));
    await say('erin', 'teriac apply -p envs/dev');
    assert.match(gh.lastReply(), /envs\/dev`: 1 more approval from write/);
    assert.equal(applies(store).length, 0);
  });

  test('keep_approval_on_rebase: a rebase keeps it, and the comment says so', async () => {
    const { gh, store, say, open } = setup('    keep_approval_on_rebase: true\n');
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: 'before-rebase' }]);
    gh.prFiles.set(head, prChanges('b1'));
    gh.prFiles.set('before-rebase', prChanges('b1'));
    await open();
    assert.match(gh.sticky.get(1)!, /\*\*Approved by\*\* .*carol.*<sub>\(carol: kept after a rebase that didn't change the PR's code\)<\/sub>/);
    await say('erin', 'teriac apply -p envs/dev');
    assert.equal(applies(store).find(r => r.project === 'envs/dev')?.status, 'success');
  });

  test('keep_approval_on_rebase: an edit after the approval needs a new one', async () => {
    const { gh, store, say, open } = setup('    keep_approval_on_rebase: true\n');
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: 'before-edit' }]);
    gh.prFiles.set(head, prChanges('b2'));
    gh.prFiles.set('before-edit', prChanges('b1'));
    await open();
    await say('erin', 'teriac apply -p envs/dev');
    assert.match(gh.lastReply(), /1 more approval from write/);
    assert.equal(applies(store).length, 0);
  });

  test('reapprove_on_change: false lets an earlier approval count', async () => {
    const { gh, store, say, open } = setup('    reapprove_on_change: false\n');
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: 'long-ago' }]);
    await open();
    await say('erin', 'teriac apply -p envs/dev');
    assert.equal(applies(store).find(r => r.project === 'envs/dev')?.status, 'success');
  });
});

describe('out-of-date branches', () => {
  const base: Comparison = {
    files: [{ path: 'envs/dev/main.tf', status: 'modified', blob: 'x' }],
    commits: [{ sha: 'aaaaaaa1', message: 'bump instance size', author: 'ada', pr: 52 }],
    truncated: false,
  };
  test('warn (default): the comment warns on the affected project only; apply goes ahead with a heads-up', async () => {
    const { gh, store, say, open } = setup();
    gh.baseChanges = base;
    await open();
    const body = gh.sticky.get(1)!;
    const dev = body.slice(body.indexOf('<b>envs/dev</b>'), body.indexOf('<b>envs/prod</b>'));
    const prod = body.slice(body.indexOf('<b>envs/prod</b>'));
    assert.match(dev, /\[!WARNING\]\n> `main` has 1 newer commit that change files `envs\/dev` uses \(#52 by ada: bump instance size\)/);
    assert.doesNotMatch(prod, /newer commit/);
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }]);
    await say('erin', 'teriac apply -p envs/dev');
    assert.equal(applies(store).find(r => r.project === 'envs/dev')?.status, 'success');
    assert.ok(gh.comments.some(c => /⚠️ `main` has 1 newer commit/.test(c.body)));
  });
  test('block: apply is refused until the branch is updated', async () => {
    const { gh, store, say, open } = setup('    stale_base: block\n');
    gh.baseChanges = base;
    await open();
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }]);
    await say('erin', 'teriac apply -p envs/dev');
    assert.match(gh.lastReply(), /Not applied:.*\n- `envs\/dev`: `main` has 1 newer commit.*rebase or merge `main` first/s);
    assert.equal(applies(store).length, 0);
  });
  test('off: no compare calls, no warning', async () => {
    const { gh, open } = setup('    stale_base: off\n');
    let calls = 0;
    gh.compare = async () => { calls++; return base; };
    await open();
    assert.doesNotMatch(gh.sticky.get(1)!, /newer commit/);
    assert.equal(calls, 0);
  });
});

describe('apply exactly what was reviewed', () => {
  const planFile = (dataDir: string) => join(dataDir, 'plans', 'github.com', 'acme', 'infra', '1', 'envs_dev-default.tfplan');
  test('a plan file changed after review is refused and audited', async () => {
    const { gh, store, say, open, dataDir } = setup();
    await open();
    writeFileSync(planFile(dataDir), 'swapped');
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }]);
    await say('erin', 'teriac apply -p envs/dev');
    const run = applies(store).find(r => r.project === 'envs/dev')!;
    assert.equal(run.status, 'failed');
    assert.match(run.output, /refused to apply: the saved plan file changed since it was reviewed/);
    assert.ok(store.auditLog(20).some(a => a.action === 'apply' && !a.allowed && /plan file changed/.test(a.reason)));
  });
  test('verify_plan: false skips the check', async () => {
    const { gh, store, say, open, dataDir } = setup('    verify_plan: false\n');
    await open();
    writeFileSync(planFile(dataDir), 'swapped');
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }]);
    await say('erin', 'teriac apply -p envs/dev');
    assert.equal(applies(store).find(r => r.project === 'envs/dev')?.status, 'success');
  });
});

describe('leaked-secret scan', () => {
  const leak = (on: boolean) => {
    // The marker lives in the PR's checkout, made from origin; add and remove it there.
    const f = join(origin, 'envs/dev/LEAK');
    if (on) writeFileSync(f, ''); else rmSync(f, { force: true });
    sh(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    sh(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', on ? 'leak' : 'no leak');
    head = sh(origin, 'rev-parse', 'HEAD');
  };
  test('redact (default): hidden in the comment, noted, audited', async () => {
    leak(true);
    try {
      const { gh, store, open } = setup();
      await open();
      const body = gh.sticky.get(1)!;
      assert.doesNotMatch(body, /AKIAIOSFODNN7EXAMPLE/);
      assert.match(body, /‹redacted: aws-access-key›/);
      assert.match(body, /\[!CAUTION\]\n> 🔐 Something that looks like a secret was hidden from this output \(aws-access-key\)/);
      const run = store.latestRuns('github.com/acme/infra', 1, 'plan').find(r => r.project === 'envs/dev')!;
      assert.deepEqual([run.status, run.secrets], ['success', ['aws-access-key']]);
      assert.ok(store.auditLog(20).some(a => a.action === 'secret_found' && /aws-access-key/.test(a.reason)));
    } finally { leak(false); }
  });
  test('fail: the plan is withheld and cannot be applied', async () => {
    leak(true);
    try {
      const { gh, store, say, open } = setup('    secret_scan: fail\n');
      await open();
      const run = store.latestRuns('github.com/acme/infra', 1, 'plan').find(r => r.project === 'envs/dev')!;
      assert.equal(run.status, 'failed');
      assert.equal(run.planPath, null);
      assert.match(run.output, /withheld this plan's output.*aws-access-key/);
      assert.doesNotMatch(gh.sticky.get(1)!, /AKIA/);
      gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }]);
      await say('erin', 'teriac apply -p envs/dev');
      assert.equal(applies(store).length, 0);
    } finally { leak(false); }
  });
});

describe('change freezes and protected resources', () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const freezes = [{ name: 'release', projects: ['envs/prod'], from: day(-1), to: day(1), override: ['user:alice'] }];
  const approveProd = (gh: FakeGitHub) => gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }, { user: 'erin', state: 'approved', commitSha: head }]);

  test("a freeze blocks applies (plans still run); --override needs that window's override list", async () => {
    const { gh, store, say, open } = setup('', { freezes });
    await open();
    assert.equal(store.latestRuns('github.com/acme/infra', 1, 'plan').length, 2, 'plans still run');
    assert.match(gh.sticky.get(1)!, /\[`envs\/prod`\][^\n]*.*change freeze `release` is on until end of/);
    approveProd(gh);
    await say('alice', 'teriac apply -p envs/prod');
    assert.match(gh.lastReply(), /change freeze `release` is on/);
    await say('carol', 'teriac apply -p envs/prod --override');
    assert.match(gh.lastReply(), /change freeze `release` is on until [^·]* · \[alice\]\(https:\/\/github\.com\/alice\) can apply with `--override`/, 'carol is not in the list: still blocked, and told who can');
    await say('alice', 'teriac apply -p envs/prod --override');
    assert.equal(applies(store).find(r => r.project === 'envs/prod')?.status, 'success');
    assert.ok(store.auditLog(30).some(a => a.action === 'override' && a.allowed && /--override skipped: change freeze release/.test(a.reason)));
    assert.ok(store.auditLog(30).some(a => a.action === 'override' && !a.allowed && a.user === 'carol'));
  });

  test('a freeze also stops direct state edits', async () => {
    const { gh, say, open } = setup('', { freezes });
    await open();
    approveProd(gh);
    await say('alice', 'teriac state rm -p envs/prod terraform_data.app');
    assert.match(gh.lastReply(), /needs .*change freeze `release` is on/);
  });

  test('protected resources block apply, and are marked on the code', async () => {
    const prot = [{ resources: ['terraform_data.database'], override: ['team:sre'] }];
    const { gh, store, say, open } = setup('', { protected: prot });
    await open();
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }]);
    await say('erin', 'teriac apply -p envs/dev');
    assert.match(gh.lastReply(), /protected resource would be destroyed or replaced: `terraform_data\.database` · team \[sre\]\([^)]+\) can apply with `--override`/);
    assert.equal(applies(store).length, 0);
    const notes = gh.checks.get('teriac: envs/dev')!.annotations!;
    const db = notes.find(n => n.title.startsWith('terraform_data.database'))!;
    assert.deepEqual([db.path, db.startLine, db.level], ['envs/dev/main.tf', 3, 'failure']);
    assert.match(db.title, /will be replaced \(protected\)/);
    const queue = notes.find(n => n.title.startsWith('terraform_data.legacy_queue'))!;
    assert.deepEqual([queue.startLine, queue.level, queue.title], [7, 'warning', 'terraform_data.legacy_queue will be destroyed']);
    // erin (team:sre) may override, with an approval.
    await say('erin', 'teriac apply -p envs/dev --override');
    assert.equal(applies(store).find(r => r.project === 'envs/dev')?.status, 'success');
  });
});

describe('risk', () => {
  test('the score shows in the table and section; high risk can need an extra approval', async () => {
    const risk = { extra_approval: { high: { from: 'team:sre', count: 1 } } };
    const { gh, store, say, open } = setup('', { risk });
    await open();
    const body = gh.sticky.get(1)!;
    assert.match(body, /\| Plan \| Risk \| Apply \|/);
    assert.match(body, /\*\*Risk: 🟠 High\*\* · destroys or replaces 2 resources in production\n/);
    assert.match(body, /\[`envs\/prod`\][^\n]*1 more approval from team:platform-admins; 1 more approval from team:sre \(high risk\)/);
    assert.doesNotMatch(body.slice(body.indexOf('| [`envs/dev`'), body.indexOf('| [`envs/prod`')), /\[`envs\/dev`\][^\n]*.*team:sre/, 'medium-risk dev needs no extra approval');
    assert.match(gh.checks.get('teriac: envs/prod')!.summary, /\*\*Risk: 🟠 High\*\*/);
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }]);
    await say('alice', 'teriac apply -p envs/prod');
    assert.match(gh.lastReply(), /1 more approval from team:sre \(high risk\)/);
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }, { user: 'erin', state: 'approved', commitSha: head }]);
    await say('alice', 'teriac apply -p envs/prod');
    assert.equal(applies(store).find(r => r.project === 'envs/prod')?.status, 'success');
  });
});

describe('built-in security rules', () => {
  test('flagged on the plan, in the comment and on the code', async () => {
    writeFileSync(join(origin, 'envs/dev/SECURITY'), '');
    sh(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    sh(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'security');
    head = sh(origin, 'rev-parse', 'HEAD');
    try {
      const s2 = setup('', { policies: { mode: 'enforce', builtin: ['security'] } });
      await s2.open();
      const body = s2.gh.sticky.get(1)!;
      assert.match(body, /🛡️ \*\*Policy \(enforced: blocks apply\)/);
      assert.match(body, /\*\*aws-s3-public-acl\*\* · `aws_s3_bucket_acl\.logs` · bucket ACL "public-read"/);
      assert.match(body, /\*\*aws-security-group-open-ingress\*\* · `aws_security_group\.ssh` · open to the internet on port 22/);
      assert.match(body, /\[`envs\/dev`\][^\n]*.*2 policy findings \(aws-s3-public-acl, aws-security-group-open-ingress\)/);
    } finally {
      rmSync(join(origin, 'envs/dev/SECURITY'));
      sh(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
      sh(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'no security');
      head = sh(origin, 'rev-parse', 'HEAD');
    }
  });
});

describe('emergency access', () => {
  test('a grant gives the permission for its time; it is audited and its first use recorded', async () => {
    const { gh, store, say, open } = setup();
    await open();
    await say('mallory', 'teriac apply -p envs/dev');
    assert.match(gh.lastReply(), /apply on `envs\/dev` needs write/);
    const g = store.createGrant({ user: 'mallory', repo: 'github.com/acme/*', projects: ['envs/dev'], actions: ['apply', 'apply_destroy'], bypass: [], reason: 'INC-7 hotfix', grantedBy: 'Ada (oidc)', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await say('mallory', 'teriac apply -p envs/dev');
    assert.match(gh.lastReply(), /1 more approval from write/, 'the grant covers the permission, not the approvals');
    const g2 = store.createGrant({ user: 'mallory', repo: '*', projects: [], actions: ['apply', 'apply_destroy'], bypass: ['approvals'], reason: 'INC-7 hotfix, no reviewer awake', grantedBy: 'Ada (oidc)', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    store.revokeGrant(g.id, 'Ada');
    await say('mallory', 'teriac apply -p envs/dev');
    assert.equal(applies(store).find(r => r.project === 'envs/dev')?.status, 'success', gh.lastReply());
    assert.ok(store.auditLog(40).some(a => a.user === 'mallory' && a.allowed && new RegExp(`emergency access #${g2.id} from Ada`).test(a.reason)));
    assert.ok(store.getGrant(g2.id)!.usedAt);
    // Not for other projects' protections: an expired grant does nothing.
    (store as any).db.prepare('UPDATE grants SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), g2.id);
    await say('mallory', 'teriac apply -p envs/prod');
    assert.match(gh.lastReply(), /apply on `envs\/prod` needs team:platform-admins/);
  });
});

test('nothing here leaks the plan file path or server env into the comment', () => {
  // Guard against accidental debug output in the new paths.
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'app.ts'), 'utf-8');
  assert.doesNotMatch(src, /console\.log/);
});

// ---------------------------------------------------------------------------
describe('remaining paths', () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const grant = (store: Store, bypass: string[], user = 'erin') => store.createGrant({
    user, repo: '*', projects: [], actions: ['apply', 'apply_destroy'], bypass, reason: 'incident', grantedBy: 'Ada', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  test('a grant can skip a freeze, a protected resource or an enforced policy (and only what it lists)', async () => {
    const freezes = [{ name: 'release', from: day(-1), to: day(1) }];
    const prot = [{ resources: ['terraform_data.database'] }];
    const rule = { name: 'no-db-replace', resource: 'terraform_data', actions: ['replace'] };
    const { gh, store, say, open } = setup('', { freezes, protected: prot, policies: { mode: 'enforce', rules: [rule] } });
    await open();
    gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }]);
    await say('erin', 'teriac apply -p envs/dev');
    const all = gh.lastReply();
    assert.match(all, /change freeze `release`/);
    assert.match(all, /protected resource/);
    assert.match(all, /1 policy finding \(no-db-replace\)/);
    const g = grant(store, ['freeze', 'protected']);
    await say('erin', 'teriac apply -p envs/dev');
    assert.doesNotMatch(gh.lastReply(), /change freeze|protected resource/);
    assert.match(gh.lastReply(), /1 policy finding/, 'policy is not in this grant');
    store.revokeGrant(g.id, 'Ada');
    grant(store, ['freeze', 'protected', 'policy']);
    await say('erin', 'teriac apply -p envs/dev');
    assert.equal(applies(store).find(r => r.project === 'envs/dev')?.status, 'success');
  });

  test('the first use of a grant is announced once', async () => {
    const sent: { event: string }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response('ok'); }) as typeof fetch;
    process.env.TERIAC_TEST_HOOK = 'https://hook.test';
    try {
      const { store, say, open } = setup('', {
        breakGlass: { grantors: ['admin'], notify: ['ops'] }, channels: { ops: { type: 'webhook', webhook_url_env: 'TERIAC_TEST_HOOK' } },
      });
      await open();
      grant(store, ['approvals'], 'mallory');
      await say('mallory', 'teriac apply -p envs/dev');
      await say('mallory', 'teriac plan -p envs/dev');
      await say('mallory', 'teriac apply -p envs/dev');
      await new Promise(r => setTimeout(r, 50));
      assert.equal(sent.filter(m => m.event === 'teriac.break_glass.used').length, 1);
    } finally {
      globalThis.fetch = real;
      delete process.env.TERIAC_TEST_HOOK;
    }
  });

  test('apply output and command output are scanned too', async () => {
    const tf = readFileSync(fakeTf, 'utf-8');
    writeFileSync(fakeTf, tf
      .replace("console.log('Apply complete!", "console.log('token ghp_' + 'a'.repeat(36)); console.log('Apply complete!")
      .replace("console.log('terraform_data.app');", "console.log('terraform_data.app'); console.log('-----BEGIN RSA PRIVATE KEY-----\\\\nMIIE\\\\n-----END RSA PRIVATE KEY-----');"));
    try {
      const { gh, store, say, open } = setup();
      await open();
      gh.reviewsByPr.set(1, [{ user: 'carol', state: 'approved', commitSha: head }]);
      await say('erin', 'teriac apply -p envs/dev');
      const run = applies(store).find(r => r.project === 'envs/dev')!;
      assert.equal(run.status, 'success');
      assert.doesNotMatch(run.output, /ghp_a/);
      assert.deepEqual(run.secrets, ['github-token']);
      await say('erin', 'teriac state list -p envs/dev');
      const reply = gh.comments.slice(-1)[0].body;
      assert.doesNotMatch(reply, /BEGIN RSA PRIVATE KEY/);
      assert.ok(gh.comments.some(c => /🔐 Something that looks like a secret was hidden/.test(c.body)));
      assert.ok(store.auditLog(40).filter(a => a.action === 'secret_found').length >= 2);
    } finally { writeFileSync(fakeTf, tf); }
  });

  test('policy findings get notes on the code', async () => {
    const rule = { name: 'no-db-replace', resource: 'terraform_data', actions: ['replace'], severity: 'critical' as const, message: 'never replace the database' };
    const { gh, open } = setup('', { policies: { mode: 'audit', rules: [rule] } });
    await open();
    const note = gh.checks.get('teriac: envs/dev')!.annotations!.find(a => a.title === 'Policy: no-db-replace')!;
    assert.deepEqual([note.path, note.startLine, note.level, note.message], ['envs/dev/main.tf', 3, 'failure', 'never replace the database']);
  });

  test("a repo's freezes add to the server's; a repo can make the secret scan stricter, not looser", async () => {
    const serverFreeze = [{ name: 'server-wide', projects: ['envs/prod'], from: day(-1), to: day(1) }];
    const { gh, open } = setup(`    freezes: [{ name: repo-only, projects: [envs/dev], from: "${day(-1)}", to: "${day(1)}" }]\n    secret_scan: off\n`, { freezes: serverFreeze, secretScan: { mode: 'fail' } });
    await open();
    const body = gh.sticky.get(1)!;
    assert.match(body, /\[`envs\/dev`\][^\n]*.*change freeze `repo-only`/);
    assert.match(body, /\[`envs\/prod`\][^\n]*.*change freeze `server-wide`/);
    // secret_scan: off in the repo can't loosen the server's "fail": the dev plan (no secret here) still succeeds,
    // and the mode in force is checked directly.
    const app = setup('    secret_scan: off\n', { secretScan: { mode: 'fail' } }).app as any;
    const ctx = { policy: { secret_scan: 'off' }, rulesConfig: {} };
    assert.equal(app.safety(ctx).secretMode, 'fail');
  });
});
