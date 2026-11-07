// Shallow, credential-free checkouts of a PR's head commit.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CloneAuth } from './vcs/types.ts';

export const git = (cwd: string, args: string[], auth?: CloneAuth): Promise<string> => new Promise((resolve, reject) => {
  // The token travels as a header for this command only; nothing is saved to .git/config.
  const prefix = auth?.extraHeader ? ['-c', `http.extraHeader=${auth.extraHeader}`] : [];
  execFile('git', [...prefix, ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    maxBuffer: 16 * 1024 * 1024,
  }, (err, stdout, stderr) => {
    if (err) reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim()}`));
    else resolve(stdout);
  });
});

/**
 * Makes `dir` a clean checkout of `sha`. Keeps .terraform and
 * .terragrunt-cache between runs so re-plans skip provider downloads.
 */
export const checkout = async (dir: string, auth: CloneAuth, sha: string, prRef?: string): Promise<void> => {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    await git(dir, ['init', '-q']);
    await git(dir, ['remote', 'add', 'origin', auth.url]);
  } else {
    await git(dir, ['remote', 'set-url', 'origin', auth.url]);
  }
  try {
    await git(dir, ['fetch', '-q', '--depth=1', '--no-tags', 'origin', sha], auth);
  } catch (err) {
    // Some servers refuse fetching by SHA; fall back to the PR ref.
    if (!prRef) throw err;
    await git(dir, ['fetch', '-q', '--depth=1', '--no-tags', 'origin', prRef], auth);
  }
  await git(dir, ['checkout', '-q', '--force', '--detach', sha]);
  await git(dir, ['clean', '-q', '-ffdx', '-e', '.terraform', '-e', '.terragrunt-cache']);
};

/**
 * Checks out the tip of `branch` with its history but without old file
 * contents (a blobless partial clone), so `git log -L` can attribute lines.
 * Returns the commit SHA.
 */
export const checkoutBranch = async (dir: string, auth: CloneAuth, branch: string): Promise<string> => {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    await git(dir, ['init', '-q']);
    await git(dir, ['remote', 'add', 'origin', auth.url]);
    // Mark origin as a promisor so missing blobs are fetched on demand.
    await git(dir, ['config', 'remote.origin.promisor', 'true']);
    await git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
  } else {
    await git(dir, ['remote', 'set-url', 'origin', auth.url]);
  }
  const ref = `refs/remotes/origin/${branch}`;
  await git(dir, ['fetch', '-q', '--filter=blob:none', '--no-tags', 'origin', `+refs/heads/${branch}:${ref}`], auth);
  await git(dir, ['checkout', '-q', '--force', '--detach', ref], auth);
  await git(dir, ['clean', '-q', '-ffdx', '-e', '.terraform', '-e', '.terragrunt-cache']);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
};
