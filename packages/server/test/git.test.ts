import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkout, checkoutBranch } from '../src/git.ts';

test('recovers a checkout that was interrupted before the remote was added', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tfv-git-'));
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
