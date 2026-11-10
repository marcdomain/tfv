import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { discoverProjects, affectedProjects } from '../src/discovery.ts';
import { loadRepoConfig, emptyRepoConfig } from '../src/repoConfig.ts';

let root: string;
const write = (path: string, text = '') => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'teriac-disc-'));
  // Plain terraform root modules using a shared local module.
  write('.terraform-version', '1.9.8\n');
  write('envs/prod/main.tf', 'module "net" {\n  source = "../../modules/network"\n}\n');
  write('envs/dev/main.tf', 'module "net" {\n  source = "../../modules/network"\n}\n');
  write('modules/network/main.tf', 'module "sub" {\n  source = "../subnet"\n}\n');
  write('modules/subnet/main.tf', 'resource "x" "y" {}\n');
  write('modules/unused/main.tf', 'resource "x" "y" {}\n'); // library module: not a project
  // An OpenTofu project (.tofu files).
  write('tofu-app/main.tofu', 'resource "x" "y" {}\n');
  // Terragrunt: root.hcl config, vpc unit, app unit depending on vpc.
  write('live/root.hcl', 'remote_state {}\n');
  write('live/.opentofu-version', '1.8.5\n');
  write('live/prod/vpc/terragrunt.hcl', 'include "root" {\n  path = find_in_parent_folders("root.hcl")\n}\nterraform {\n  source = "../../../modules/network"\n}\n');
  write('live/prod/app/terragrunt.hcl', 'dependency "vpc" {\n  config_path = "../vpc"\n}\nlocals {\n  common = read_terragrunt_config("../common.hcl")\n}\n');
  write('live/prod/common.hcl', 'locals {}\n');
  // Ignored places.
  write('envs/prod/.terraform/modules/x/main.tf', 'resource "x" "y" {}\n');
  write('node_modules/pkg/main.tf', '');
});

after(() => rmSync(root, { recursive: true, force: true }));

const names = (list: { name: string }[]) => list.map(p => p.name).sort();

test('finds root modules, skips library modules and caches', () => {
  const projects = discoverProjects(root, emptyRepoConfig());
  assert.deepEqual(names(projects), ['envs/dev', 'envs/prod', 'live/prod/app', 'live/prod/vpc', 'tofu-app']);
});

test('picks the engine and underlying tool', () => {
  const byName = new Map(discoverProjects(root, emptyRepoConfig()).map(p => [p.name, p]));
  assert.equal(byName.get('envs/prod')!.engine, 'terraform');
  assert.equal(byName.get('tofu-app')!.engine, 'opentofu');
  assert.equal(byName.get('live/prod/vpc')!.engine, 'terragrunt');
  assert.equal(byName.get('live/prod/vpc')!.tool, 'opentofu'); // from live/.opentofu-version
});

test('a module change plans every project that uses it, transitively', () => {
  const projects = discoverProjects(root, emptyRepoConfig());
  assert.deepEqual(names(affectedProjects(projects, ['modules/subnet/main.tf'])), ['envs/dev', 'envs/prod', 'live/prod/app', 'live/prod/vpc']);
});

test('a project change only plans that project', () => {
  const projects = discoverProjects(root, emptyRepoConfig());
  assert.deepEqual(names(affectedProjects(projects, ['envs/dev/main.tf'])), ['envs/dev']);
});

test('terragrunt: dependencies cascade, shared config and parent hcl count', () => {
  const projects = discoverProjects(root, emptyRepoConfig());
  assert.deepEqual(names(affectedProjects(projects, ['live/prod/vpc/terragrunt.hcl'])), ['live/prod/app', 'live/prod/vpc']);
  assert.deepEqual(names(affectedProjects(projects, ['live/prod/common.hcl'])), ['live/prod/app', 'live/prod/vpc']);
  assert.deepEqual(names(affectedProjects(projects, ['live/root.hcl'])), ['live/prod/app', 'live/prod/vpc']);
});

test('a root version pin change replans everything below it', () => {
  const projects = discoverProjects(root, emptyRepoConfig());
  assert.equal(affectedProjects(projects, ['.terraform-version']).length, projects.length);
});

test('unrelated files plan nothing', () => {
  const projects = discoverProjects(root, emptyRepoConfig());
  assert.deepEqual(affectedProjects(projects, ['README.md', 'docs/x.md']), []);
});

test('teriac.yaml adds names, workspaces and watch globs', () => {
  write('teriac.yaml', [
    'projects:',
    '  - name: prod-network',
    '    dir: envs/prod',
    '  - name: prod-network-dr',
    '    dir: envs/prod',
    '    workspace: dr',
    '    watch: ["../../modules/unused/**"]',
  ].join('\n'));
  try {
    const projects = discoverProjects(root, loadRepoConfig(root));
    assert.ok(names(projects).includes('prod-network'));
    assert.ok(names(projects).includes('prod-network-dr'));
    assert.ok(!names(projects).includes('envs/prod'));
    assert.deepEqual(names(affectedProjects(projects, ['modules/unused/x.tf'])).filter(n => n.startsWith('prod')), ['prod-network-dr']);
  } finally {
    rmSync(join(root, 'teriac.yaml'));
  }
});

test('repo config cannot point outside the repo', () => {
  write('teriac.yaml', 'projects:\n  - dir: ../../etc\n');
  try {
    assert.throws(() => loadRepoConfig(root), /must stay inside the repo/);
  } finally {
    rmSync(join(root, 'teriac.yaml'));
  }
});

test('symlinks are not followed', () => {
  const outside = mkdtempSync(join(tmpdir(), 'teriac-outside-'));
  writeFileSync(join(outside, 'main.tf'), '');
  symlinkSync(outside, join(root, 'linked'));
  try {
    assert.ok(!names(discoverProjects(root, emptyRepoConfig())).includes('linked'));
  } finally {
    rmSync(join(root, 'linked'));
    rmSync(outside, { recursive: true, force: true });
  }
});
