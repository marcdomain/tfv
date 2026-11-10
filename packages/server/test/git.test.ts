import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkout, checkoutBranch } from '../src/git.ts';

test('recovers a checkout that was interrupted before the remote was added', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teriac-git-'));
  try {
    const origin = join(tmp, 'origin');
    mkdirSync(origin);
    const g = (...a: string[]) => execFileSync('git', a, { cwd: origin, encoding: 'utf-8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'uploadpack.allowAnySHA1InWant', 'true');
    g('config', 'uploadpack.allowFilter', 'true');
    writeFileSync(join(origin, 'main.tf'), 'v1\n');
    g('add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'v1');
    const sha = g('rev-parse', 'HEAD');

    // A half-made checkout: `git init` ran, the process died before `remote add`.
    for (const [name, fn] of [['pr', () => checkout(join(tmp, 'pr'), { url: origin }, sha)], ['branch', () => checkoutBranch(join(tmp, 'branch'), { url: origin }, 'main')]] as const) {
      mkdirSync(join(tmp, name));
      execFileSync('git', ['init', '-q'], { cwd: join(tmp, name) });
      await fn();
      assert.equal(readFileSync(join(tmp, name, 'main.tf'), 'utf-8'), 'v1\n');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a PR checkout keeps local state files between runs, but removes other leftovers', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teriac-git-'));
  try {
    const origin = join(tmp, 'origin');
    mkdirSync(join(origin, 'infra'), { recursive: true });
    const g = (...a: string[]) => execFileSync('git', a, { cwd: origin, encoding: 'utf-8' }).trim();
    g('init', '-q', '-b', 'main');
    g('config', 'uploadpack.allowAnySHA1InWant', 'true');
    writeFileSync(join(origin, 'infra/main.tf'), 'v1\n');
    g('add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'v1');
    const sha = g('rev-parse', 'HEAD');
    const work = join(tmp, 'work');
    await checkout(work, { url: origin }, sha);
    writeFileSync(join(work, 'infra/terraform.tfstate'), '{"serial":3}');
    writeFileSync(join(work, 'infra/leftover.txt'), 'x');
    await checkout(work, { url: origin }, sha);
    assert.equal(readFileSync(join(work, 'infra/terraform.tfstate'), 'utf-8'), '{"serial":3}');
    assert.throws(() => readFileSync(join(work, 'infra/leftover.txt')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
