// A Terragrunt repo laid out the common way: root.hcl, _envcommon, env/account
// files, dependencies built with path functions, extra files listed in locals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { discoverProjects, affectedProjects } from '../src/discovery.ts';
import { emptyRepoConfig } from '../src/repoConfig.ts';

let root: string;
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'teriac-tg-'));
  write('root.hcl', 'remote_state {}\n');
  write('live/account.hcl', 'locals { account_id = "111" }\n');
  write('live/prod/env.hcl', 'locals { env = "prod" }\n');
  write('config/global.yaml', 'owner: platform\n');
  write('policies/s3.json', '{}\n');
  // _envcommon: shared unit config, pulled in by an include with get_repo_root()
  write('_envcommon/app.hcl', 'terraform {\n  source = "${get_repo_root()}/infra-modules//app"\n}\n');
  // Modules live in "infra-modules", not "modules": they must still not become projects.
  write('infra-modules/app/main.tf', 'module "shared" {\n  source = "../shared"\n}\n');
  write('infra-modules/shared/main.tf', 'resource "terraform_data" "x" {}\n');
  write('infra-modules/vpc/main.tf', 'resource "terraform_data" "vpc" {}\n');
  write('live/prod/vpc/terragrunt.hcl', [
    'include "root" {',
    '  path = find_in_parent_folders("root.hcl")',
    '}',
    'terraform {',
    '  source = "${get_repo_root()}/infra-modules//vpc"',
    '}',
  ].join('\n'));
  write('live/prod/app/terragrunt.hcl', [
    'include "root" {',
    '  path = find_in_parent_folders("root.hcl")',
    '}',
    'include "envcommon" {',
    '  path   = "${get_repo_root()}/_envcommon/app.hcl"',
    '  expose = true',
    '}',
    'dependency "vpc" {',
    '  config_path = "${get_terragrunt_dir()}/../vpc"',
    '  mock_outputs = { vpc_id = "vpc-123" }',
    '}',
    'locals {',
    '  env     = read_terragrunt_config(find_in_parent_folders("env.hcl"))',
    '  account = read_terragrunt_config(find_in_parent_folders("account.hcl"))',
    '  extra_files = [',
    '    "${get_repo_root()}/config/global.yaml",',
    '  ]',
    '}',
    'inputs = {',
    '  name   = "app"',
    '  policy = file("${get_terragrunt_dir()}/../../../policies/s3.json")',
    '}',
  ].join('\n'));
  write('live/prod/dns/terragrunt.hcl', 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\nterraform {\n  source = "${get_repo_root()}/infra-modules//vpc"\n}\n');
  // Paths built from locals, and a script run by a hook.
  write('live/prod/team.yaml', 'team: payments\n');
  write('scripts/check.sh', '#!/bin/sh\n');
  write('live/prod/queue/terragrunt.hcl', [
    'locals {',
    '  env_dir = "${get_terragrunt_dir()}/.."',
    '  team    = yamldecode(file("${local.env_dir}/team.yaml"))',
    '}',
    'terraform {',
    '  source = "${get_repo_root()}/infra-modules//vpc"',
    '  before_hook "check" {',
    '    commands = ["plan"]',
    '    execute  = ["sh", "${get_repo_root()}/scripts/check.sh"]',
    '  }',
    '}',
  ].join('\n'));
  // A plain Terraform project that reads a file from outside its folder.
  write('stacks/iam/main.tf', 'resource "terraform_data" "p" {\n  input = file("${path.module}/../../policies/s3.json")\n}\n');
});

after(() => rmSync(root, { recursive: true, force: true }));

const affected = (files: string[]) => affectedProjects(discoverProjects(root, emptyRepoConfig()), files).map(p => p.name).sort();

test('finds the Terragrunt units and the plain project; modules are not projects', () => {
  const projects = discoverProjects(root, emptyRepoConfig());
  assert.deepEqual(projects.map(p => `${p.name}:${p.engine}`).sort(), [
    'live/prod/app:terragrunt', 'live/prod/dns:terragrunt', 'live/prod/queue:terragrunt', 'live/prod/vpc:terragrunt', 'stacks/iam:terraform',
  ]);
});

test('_envcommon include (via get_repo_root) and the modules it sources', () => {
  assert.deepEqual(affected(['_envcommon/app.hcl']), ['live/prod/app']);
  assert.deepEqual(affected(['infra-modules/app/main.tf']), ['live/prod/app']);
  assert.deepEqual(affected(['infra-modules/shared/main.tf']), ['live/prod/app'], 'module of a module');
});

test('dependency via get_terragrunt_dir() cascades', () => {
  assert.deepEqual(affected(['live/prod/vpc/terragrunt.hcl']), ['live/prod/app', 'live/prod/vpc']);
  assert.deepEqual(affected(['infra-modules/vpc/main.tf']), ['live/prod/app', 'live/prod/dns', 'live/prod/queue', 'live/prod/vpc']);
});

test('read_terragrunt_config(find_in_parent_folders(...)) and parent config', () => {
  assert.deepEqual(affected(['live/prod/env.hcl']), ['live/prod/app', 'live/prod/dns', 'live/prod/queue', 'live/prod/vpc']);
  assert.deepEqual(affected(['root.hcl']), ['live/prod/app', 'live/prod/dns', 'live/prod/queue', 'live/prod/vpc']);
});

test('paths listed in locals and file() references', () => {
  assert.deepEqual(affected(['config/global.yaml']), ['live/prod/app']);
  assert.deepEqual(affected(['policies/s3.json']), ['live/prod/app', 'stacks/iam']);
});

test('found naturally: paths built from locals, and hook scripts', () => {
  assert.deepEqual(affected(['scripts/check.sh']), ['live/prod/queue']);
  // team.yaml sits in a parent folder of queue, and is also read through local.env_dir.
  assert.deepEqual(affected(['live/prod/team.yaml']).includes('live/prod/queue'), true);
});

test('a local path outside the parent folders is found only through the local', () => {
  write('shared/limits.yaml', 'max: 3\n');
  write('live/prod/worker/terragrunt.hcl', 'locals {\n  shared = "${get_repo_root()}/shared"\n  limits = yamldecode(file("${local.shared}/limits.yaml"))\n}\nterraform {\n  source = "${get_repo_root()}/infra-modules//vpc"\n}\n');
  assert.deepEqual(affected(['shared/limits.yaml']), ['live/prod/worker']);
});

test('unrelated changes plan nothing', () => {
  assert.deepEqual(affected(['README.md', 'docs/runbook.md']), []);
});

test('teriac watch: comment, Terragrunt local and teriac.yaml; globs; added to automatic detection', async () => {
  const { loadRepoConfig } = await import('../src/repoConfig.ts');
  write('lambda/orders/handler.py', 'x\n');
  write('lambda/orders/lib/util.py', 'x\n');
  write('lambda/orders/README.md', 'x\n');
  write('schemas/order.json', '{}\n');
  write('docs/runbook.md', 'x\n');
  // 1. A comment in any project file.
  write('stacks/orders/main.tf', '# teriac:watch /lambda/orders/**/*.py\nresource "terraform_data" "o" {}\n');
  // 2. A Terragrunt local, using functions.
  write('live/prod/orders/terragrunt.hcl', [
    'locals {',
    '  teriac_watch = ["${get_repo_root()}/schemas/*.json", "${get_terragrunt_dir()}/../../../lambda/orders"]',
    '}',
    'terraform {',
    '  source = "${get_repo_root()}/infra-modules//vpc"',
    '}',
  ].join('\n'));
  // 3. teriac.yaml.
  write('teriac.yaml', 'projects:\n  - dir: stacks/iam\n    watch: ["/docs/*.md"]\n');
  try {
    const projects = discoverProjects(root, loadRepoConfig(root));
    const hit = (f: string) => affectedProjects(projects, [f]).map(p => p.name).sort();
    assert.ok(hit('lambda/orders/lib/util.py').includes('stacks/orders'), 'comment glob, nested folder');
    assert.ok(!hit('lambda/orders/README.md').includes('stacks/orders'), 'only *.py');
    assert.ok(hit('lambda/orders/README.md').includes('live/prod/orders'), 'a plain folder means everything in it');
    assert.ok(hit('schemas/order.json').includes('live/prod/orders'));
    assert.deepEqual(hit('docs/runbook.md'), ['stacks/iam']);
    // Still planned by its own files and references: watch adds, never replaces.
    assert.ok(hit('policies/s3.json').includes('stacks/iam'));
  } finally {
    rmSync(join(root, 'teriac.yaml'));
  }
});

test('dependency blocks: where they point and their mock values', async () => {
  const { terragruntDependencies, mockedDependencies } = await import('../src/discovery.ts');
  const text = [
    'dependency "vpc" {',
    '  config_path = "${get_terragrunt_dir()}/../vpc"',
    '  mock_outputs = {',
    '    vpc_id  = "vpc-MOCK"',
    '    subnets = ["subnet-MOCK-a", "subnet-MOCK-b"]',
    '  }',
    '}',
    'dependency "dns" {',
    '  config_path = "../dns"',
    '}',
  ].join('\n');
  const deps = terragruntDependencies(root, 'live/prod/app', text);
  assert.deepEqual(deps, [
    { name: 'vpc', dir: 'live/prod/vpc', mocks: ['vpc-MOCK', 'subnet-MOCK-a', 'subnet-MOCK-b'] },
    { name: 'dns', dir: 'live/prod/dns', mocks: [] },
  ]);
  // Terragrunt's own warning (exact line from terragrunt 0.83.2).
  const warn = '00:11:53.711 WARN   Config ../vpc/terragrunt.hcl is a dependency of ./terragrunt.hcl that has no outputs, but mock outputs provided and returning those in dependency output.';
  assert.deepEqual(mockedDependencies('live/prod/app', deps, warn, {}), ['live/prod/vpc']);
  // Or the mock value turning up in the plan's inputs, even without the log line.
  assert.deepEqual(mockedDependencies('live/prod/app', deps, '', { variables: { subnet_ids: { value: ['subnet-MOCK-a'] } } }), ['live/prod/vpc']);
  // Real outputs: nothing flagged.
  assert.deepEqual(mockedDependencies('live/prod/app', deps, 'Plan: 1 to add', { variables: { vpc_id: { value: 'vpc-0a1b2c3d' } } }), []);
});

test('a unit without mock_outputs whose dependency is not applied: names the dependency', async () => {
  const { terragruntDependencies, unappliedDependencies } = await import('../src/discovery.ts');
  const deps = terragruntDependencies(root, 'live/prod/app', 'dependency "vpc" {\n  config_path = "${get_terragrunt_dir()}/../vpc"\n}\n');
  assert.deepEqual(deps, [{ name: 'vpc', dir: 'live/prod/vpc', mocks: [] }]);
  // Exact lines from terragrunt 0.83.2: relative to the unit, or (paths tidied) to the checkout.
  const relative = '* ../vpc/terragrunt.hcl is a dependency of ./terragrunt.hcl but detected no outputs. Either the target module has not been applied yet, or the module has no outputs.';
  assert.deepEqual(unappliedDependencies('live/prod/app', deps, relative), ['live/prod/vpc']);
  const tidied = '* ./live/prod/vpc/terragrunt.hcl is a dependency of ./live/prod/app/terragrunt.hcl but detected no outputs.';
  assert.deepEqual(unappliedDependencies('live/prod/app', deps, tidied), ['live/prod/vpc']);
  assert.deepEqual(unappliedDependencies('live/prod/app', deps, 'Error: something else'), []);

  const { renderComment } = await import('../src/render.ts');
  const plan = { id: 1, repo: 'r', pr: 1, project: 'live/prod/app', dir: 'live/prod/app', workspace: 'default', kind: 'plan', status: 'failed', headSha: 'abc1234', user: 'bob', prAuthor: 'bob', startedAt: '', finishedAt: '', engine: 'terragrunt', summary: null, output: relative, planPath: null, hasChanges: false, destroys: 0, targets: [], policy: null, mocks: ['live/prod/vpc'], providers: [], usage: null, applied: null } as any;
  const body = renderComment({ marker: 'M', headSha: 'abc1234', command: 'teriac', limit: 65000, projects: [{ name: 'live/prod/app', plan, blockers: [] }] });
  assert.match(body, /⏳ waiting for `live\/prod\/vpc`/);
  assert.match(body, /- ⏳ \*\*`live\/prod\/app`\*\* needs `live\/prod\/vpc` applied first:\n  ```\n  teriac apply -p live\/prod\/vpc\n  ```/);
  assert.match(body, /\*\*Waiting for `live\/prod\/vpc`\*\*, which isn't applied yet and has no outputs, and this unit has no `mock_outputs`/);
});
