import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPermission, currentApprovers, approvalStatus, applyBlockers, rulesFor, ownersFor, repoPolicyFor, type Lookup,
} from '../src/policy.ts';
import { parseReposYaml } from '../src/config.ts';
import { parseRepoConfig, emptyRepoConfig } from '../src/repoConfig.ts';
import type { Project } from '../src/discovery.ts';
import type { Permission, Repo } from '../src/vcs/types.ts';

const project = (name: string): Project => ({ name, dir: name, workspace: 'default', engine: 'terraform', tool: 'terraform', autoplan: true, deps: [] });

// Fake org: who has which repo permission and team.
const PERMS: Record<string, Permission> = { alice: 'admin', bob: 'write', carol: 'write', dave: 'read', erin: 'maintain', frank: 'write' };
const TEAMS: Record<string, string[]> = { 'platform-admins': ['alice', 'carol'], 'acme/security': ['frank'] };
const CODEOWNERS = '* @acme/everyone\n/prod/ @acme/platform-admins\n/prod/db/ @frank\n';

const lookup: Lookup = {
  permission: async u => PERMS[u] ?? 'none',
  inTeam: async (team, u) => (TEAMS[team] ?? TEAMS[team.split('/').pop()!] ?? []).includes(u),
  codeowners: async () => CODEOWNERS,
};

const policy = parseReposYaml(`
repos:
  - id: github.com/acme/*
    apply_requirements: [mergeable]
    projects:
      - match: prod/**
        permissions:
          apply: [team:platform-admins]
          apply_destroy: [admin]
        approvals:
          - from: team:platform-admins
            count: 2
          - from: team:acme/security
            count: 1
      - match: "**"
        approvals:
          - from: write
            count: 1
`)[0];

const rules = (name: string, repoYaml?: string) =>
  rulesFor(project(name), policy, repoYaml ? parseRepoConfig('tfv.yaml', repoYaml) : emptyRepoConfig());

describe('repo allowlist', () => {
  const repo = (fullName: string): Repo => ({ platform: 'github', host: 'github.com', owner: fullName.split('/')[0], name: fullName.split('/')[1], fullName, cloneUrl: '' });
  test('matches by host/owner/name glob', () => {
    assert.ok(repoPolicyFor([policy], repo('acme/infra')));
    assert.equal(repoPolicyFor([policy], repo('evil/infra')), null);
  });
});

describe('RBAC permissions', () => {
  const cases: [string, 'plan' | 'apply' | 'apply_destroy' | 'unlock', string, boolean][] = [
    ['bob', 'plan', 'dev/app', true],        // default: plan needs write
    ['dave', 'plan', 'dev/app', false],      // read-only users can't run code
    ['bob', 'apply', 'dev/app', true],       // default: apply needs write
    ['bob', 'apply', 'prod/net', false],     // prod: platform-admins only
    ['carol', 'apply', 'prod/net', true],
    ['carol', 'apply_destroy', 'prod/net', false], // destroys need admin in prod
    ['alice', 'apply_destroy', 'prod/net', true],
    ['bob', 'apply_destroy', 'dev/app', false],    // default: maintain
    ['erin', 'apply_destroy', 'dev/app', true],
    ['bob', 'unlock', 'dev/app', false],
    ['erin', 'unlock', 'dev/app', true],
  ];
  for (const [user, action, name, expected] of cases) {
    test(`${user} ${action} ${name} → ${expected ? 'allowed' : 'denied'}`, async () => {
      const d = await checkPermission(action, user, project(name), rules(name), lookup);
      assert.equal(d.allowed, expected, d.reason);
    });
  }

  test('denials explain what is needed', async () => {
    const d = await checkPermission('apply', 'bob', project('prod/net'), rules('prod/net'), lookup);
    assert.equal(d.reason, 'apply on `prod/net` needs team:platform-admins');
  });

  test('repo config can tighten but never loosen', async () => {
    const tighter = 'rules:\n  - match: dev/**\n    permissions:\n      apply: [user:erin]\n';
    assert.equal((await checkPermission('apply', 'bob', project('dev/app'), rules('dev/app', tighter), lookup)).allowed, false);
    assert.equal((await checkPermission('apply', 'erin', project('dev/app'), rules('dev/app', tighter), lookup)).allowed, true);
    // Trying to open prod up to everyone has no effect: server rules still apply.
    const looser = 'rules:\n  - match: prod/**\n    permissions:\n      apply: [anyone]\n';
    assert.equal((await checkPermission('apply', 'bob', project('prod/net'), rules('prod/net', looser), lookup)).allowed, false);
  });

  test('unknown principals never grant access', async () => {
    const odd = 'rules:\n  - match: "**"\n    permissions:\n      plan: [wizard]\n';
    assert.equal((await checkPermission('plan', 'alice', project('dev/app'), rules('dev/app', odd), lookup)).allowed, false);
  });

  test('codeowners principal: last matching rule wins', async () => {
    assert.deepEqual(ownersFor(CODEOWNERS, 'prod/db'), ['user:frank']);
    assert.deepEqual(ownersFor(CODEOWNERS, 'prod/net'), ['team:acme/platform-admins']);
    assert.deepEqual(ownersFor(CODEOWNERS, 'dev/app'), ['team:acme/everyone']);
    const owners = 'rules:\n  - match: prod/**\n    permissions:\n      apply: [codeowners]\n';
    assert.equal((await checkPermission('apply', 'carol', project('prod/net'), rules('prod/net', owners), lookup)).allowed, true);
    assert.equal((await checkPermission('apply', 'carol', project('prod/db'), rules('prod/db', owners), lookup)).allowed, false);
  });
});

describe('approvals', () => {
  const HEAD = 'abc123';
  test('only current approvals of the head commit count, author excluded', () => {
    const approvers = currentApprovers([
      { user: 'alice', state: 'approved', commitSha: HEAD },
      { user: 'carol', state: 'approved', commitSha: 'old' },        // stale: before last push
      { user: 'frank', state: 'approved', commitSha: HEAD },
      { user: 'frank', state: 'commented', commitSha: HEAD },        // comment keeps approval
      { user: 'erin', state: 'approved', commitSha: HEAD },
      { user: 'erin', state: 'changes_requested', commitSha: HEAD }, // later review replaces it
      { user: 'bob', state: 'approved', commitSha: HEAD },           // the author
    ], 'bob', HEAD);
    assert.deepEqual(approvers.sort(), ['alice', 'frank']);
  });

  test('per-project approver rules show what is missing', async () => {
    const s = await approvalStatus(project('prod/net'), rules('prod/net'), ['alice', 'bob'], lookup);
    assert.equal(s.ok, false);
    assert.deepEqual(s.missing, ['1 more approval from team:platform-admins', '1 more approval from team:acme/security']);
    const done = await approvalStatus(project('prod/net'), rules('prod/net'), ['alice', 'carol', 'frank'], lookup);
    assert.equal(done.ok, true);
  });

  test('each project only needs its own approvals', async () => {
    const dev = await approvalStatus(project('dev/app'), rules('dev/app'), ['carol'], lookup);
    assert.equal(dev.ok, true);
  });

  test('apply blockers combine requirements and approvals', async () => {
    const blockers = await applyBlockers(project('dev/app'), rules('dev/app'), { mergeable: false, behindBase: false }, [], lookup);
    assert.deepEqual(blockers, ['PR is not mergeable', '1 more approval from write']);
  });
});

describe('repos.yaml validation', () => {
  test('rejects typos instead of silently allowing', () => {
    assert.throws(() => parseReposYaml('repos:\n  - id: x\n    apply_requirements: [aproved]\n'), /unknown apply requirement "aproved"/);
    assert.throws(() => parseReposYaml('repos:\n  - id: x\n    projects:\n      - match: "*"\n        permissions:\n          aply: [write]\n'), /unknown action "aply"/);
    assert.throws(() => parseReposYaml('repos:\n  - id: x\n    projects:\n      - match: "*"\n        approvals:\n          - from: write\n'), /count/);
  });
});

describe('loadConfig', () => {
  test('a configured repos.yaml that cannot be read is an error, not silently ignored', async () => {
    const { loadConfig } = await import('../src/config.ts');
    const env = { TFV_DATA_DIR: '/nonexistent-tfv', TFV_REPOS_CONFIG: '/nonexistent-tfv/repos.yaml', TFV_GITHUB_APP_ID: '1', TFV_GITHUB_PRIVATE_KEY: 'k', TFV_GITHUB_WEBHOOK_SECRET: 'w' };
    assert.throws(() => loadConfig(env), /cannot read TFV_REPOS_CONFIG \(\/nonexistent-tfv\/repos.yaml\): file not found/);
  });
});

describe('spinner availability', () => {
  test('only a public https address can serve the spinner to GitHub', async () => {
    const { spinnerUrlFor } = await import('../src/config.ts');
    assert.equal(spinnerUrlFor('https://tfv.acme.dev'), 'https://tfv.acme.dev/assets/spinner.gif');
    assert.equal(spinnerUrlFor('https://tfv.acme.dev/'), 'https://tfv.acme.dev/assets/spinner.gif');
    for (const u of ['http://tfv.acme.dev', 'https://localhost:8080', 'https://127.0.0.1', 'https://10.0.0.5', 'https://192.168.1.2', 'https://tfv.local', 'not a url']) {
      assert.equal(spinnerUrlFor(u), null, u);
    }
  });
});
