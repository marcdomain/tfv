// Approvals that survive a rebase, and the "your branch is behind main on this
// project" check. Both use the platform's compare view, so they work on teriac's
// shallow checkouts.
import { createHash } from 'node:crypto';
import type { Comparison, Review } from './vcs/types.ts';
import type { Project } from './discovery.ts';
import { affectedProjects } from './discovery.ts';

// A fingerprint of a PR's own changes at one commit: the files it changes and their
// exact contents (blob ids), compared with where the branch left the base. A rebase
// keeps it; any edit, or a conflict resolved differently, changes it. Null when it
// can't be known (no compare support, or too many files to list).
export const changeFingerprint = (c: Comparison | null): string | null => {
  if (!c || c.truncated) return null;
  const files = c.files.map(f => [f.path, f.status, f.blob ?? '', f.previous ?? ''].join('\0')).sort();
  return createHash('sha256').update(files.join('\n')).digest('hex');
};

export interface ApprovalSettings {
  reapproveOnChange: boolean;  // any code change needs a fresh approval (default)
  keepOnRebase: boolean;       // ...except a rebase that leaves the PR's changes as they were
}

export interface Approvals {
  approvers: string[];         // whose approval counts now
  carried: string[];           // of those, approvals kept across a rebase
}

// Who has approved, under these settings. `fingerprintOf` is only asked when needed.
export const countApprovals = async (
  reviews: Review[], author: string, headSha: string, settings: ApprovalSettings,
  fingerprintOf: (sha: string) => Promise<string | null>,
): Promise<Approvals> => {
  const latest = new Map<string, Review>();
  for (const r of reviews) {
    if (r.state === 'commented') continue; // comments don't change approval state
    latest.set(r.user.toLowerCase(), r);
  }
  const approved = [...latest.values()].filter(r => r.state === 'approved' && r.user.toLowerCase() !== author.toLowerCase());
  if (!settings.reapproveOnChange) return { approvers: approved.map(r => r.user), carried: [] };

  const approvers: string[] = [];
  const carried: string[] = [];
  let head: string | null | undefined;
  const same = new Map<string, boolean>();
  for (const r of approved) {
    if (r.commitSha === headSha) { approvers.push(r.user); continue; }
    if (!settings.keepOnRebase) continue;
    if (head === undefined) head = await fingerprintOf(headSha).catch(() => null);
    if (!head) continue; // can't tell: ask for a fresh approval (the safe answer)
    if (!same.has(r.commitSha)) same.set(r.commitSha, (await fingerprintOf(r.commitSha).catch(() => null)) === head);
    if (same.get(r.commitSha)) { approvers.push(r.user); carried.push(r.user); }
  }
  return { approvers, carried };
};

// Base-branch commits (since this branch left it) that change files `project` uses:
// its folder, local modules, Terragrunt dependencies, watched files and version pins.
export const staleFor = (project: Project, projects: Project[], baseChanges: Comparison | null): Comparison['commits'] | null => {
  if (!baseChanges || !baseChanges.commits.length) return null;
  const files = baseChanges.files.flatMap(f => (f.previous ? [f.path, f.previous] : [f.path]));
  // A cut-short file list might hide this project's files: say so rather than stay quiet.
  if (!baseChanges.truncated && !affectedProjects(projects, files).some(p => p.name === project.name)) return null;
  return baseChanges.commits;
};

export const staleText = (commits: Comparison['commits'], baseRef: string, project: string, blocking: boolean): string => {
  const shown = [...commits].reverse().slice(0, 3)
    .map(c => `${c.pr ? `#${c.pr}` : c.sha.slice(0, 7)} by ${c.author}: ${c.message.slice(0, 60)}`).join('; ');
  const more = commits.length > 3 ? `; and ${commits.length - 3} more` : '';
  const n = commits.length;
  return `\`${baseRef}\` has ${n} newer commit${n === 1 ? '' : 's'} that change files \`${project}\` uses (${shown}${more}). `
    + `Applying this branch could undo ${n === 1 ? 'it' : 'them'}: ${blocking ? 'rebase or merge' : 'consider rebasing or merging'} \`${baseRef}\` first`;
};
