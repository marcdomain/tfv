import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addressParts, findBlock, locate, lastAuthor } from '../src/blame.ts';

let root: string;
const commit = (name: string, email: string, msg: string) =>
  execFileSync('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-qam', msg], { cwd: root });

before(() => {
  root = mkdtempSync(join(tmpdir(), 'tfv-blame-'));
  mkdirSync(join(root, 'envs/prod'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'envs/prod/main.tf'), [
    'resource "aws_s3_bucket" "logs" {',
    '  bucket = "acme-logs"',
    '  tags = { team = "platform" }',
    '}',
    '',
    'module "network" {',
    '  source = "../../modules/network"',
    '  cidr   = "10.0.0.0/16"',
    '}',
    '',
    'resource "aws_iam_role" "app" {',
    '  name = "app"',
    '}',
    '',
  ].join('\n'));
  execFileSync('git', ['add', '-A'], { cwd: root });
  commit('Alice', 'alice@acme.dev', 'Initial prod');
  const file = join(root, 'envs/prod/main.tf');
  writeFileSync(file, readFileSync(file, 'utf-8').replace('10.0.0.0/16', '10.1.0.0/16'));
  commit('Bob', '7+bob@users.noreply.github.com', 'Widen network');
  writeFileSync(file, readFileSync(file, 'utf-8') + '# trailing comment\n');
  commit('Carol', 'carol@acme.dev', 'Comment only');
});

after(() => rmSync(root, { recursive: true, force: true }));

test('address parsing drops index keys', () => {
  assert.deepEqual(addressParts('module.network.aws_subnet.private["a"]'), ['module', 'network', 'aws_subnet', 'private']);
  assert.deepEqual(addressParts('aws_instance.web[0]'), ['aws_instance', 'web']);
});

test('findBlock follows braces, ignoring braces in strings and comments', () => {
  const text = 'resource "x" "y" {\n  a = "}"\n  # }\n  b = { c = 1 }\n}\nresource "x" "z" {}\n';
  assert.deepEqual(findBlock(text, /^resource "x" "y"/), { start: 1, end: 5 });
  assert.deepEqual(findBlock(text, /^resource "x" "z"/), { start: 6, end: 6 });
});

test('locate finds resources and module calls', () => {
  assert.deepEqual(locate(root, 'envs/prod', 'aws_s3_bucket.logs'), { file: 'envs/prod/main.tf', start: 1, end: 4, via: 'resource' });
  assert.deepEqual(locate(root, 'envs/prod', 'module.network.aws_subnet.a[0]'), { file: 'envs/prod/main.tf', start: 6, end: 9, via: 'module' });
  assert.equal(locate(root, 'envs/prod', 'aws_lambda_function.gone'), null);
});

test('each resource is blamed on whoever last changed its own lines', async () => {
  assert.equal((await lastAuthor(root, 'envs/prod', 'aws_s3_bucket.logs'))?.name, 'Alice');
  assert.equal((await lastAuthor(root, 'envs/prod', 'module.network.aws_subnet.a'))?.name, 'Bob');
  assert.equal((await lastAuthor(root, 'envs/prod', 'aws_iam_role.app'))?.name, 'Alice');
});

test('unknown resources fall back to the last commit in the project', async () => {
  const a = await lastAuthor(root, 'envs/prod', 'aws_lambda_function.gone');
  assert.equal(a?.name, 'Carol');
  assert.equal(a?.via, 'project');
});
