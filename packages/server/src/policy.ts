// RBAC and apply rules. The server's repos.yaml sets the rules; a repo's
// tfv.yaml can add rules on top. Both must pass, so a repo can only tighten.
import type { Action, ApprovalRule, Principal, ProjectRule, RepoPolicy, Requirement } from './config.ts';
import type { RepoConfig } from './repoConfig.ts';
import type { Project } from './discovery.ts';
import type { Permission, Repo, Review } from './vcs/types.ts';
import { PERMISSION_LEVELS } from './vcs/types.ts';
import { matchGlob } from './glob.ts';

// Platform lookups, cached per request by the caller.
export interface Lookup {
  permission(user: string): Promise<Permission>;
  inTeam(team: string, user: string): Promise<boolean>;
  codeowners(): Promise<string | null>;
}

export const DEFAULT_PERMISSIONS: Record<Action, Principal[]> = {
  plan: ['write'],
  apply: ['write'],
  apply_destroy: ['maintain'],
  unlock: ['maintain'],
};

export const repoPolicyFor = (policies: RepoPolicy[], repo: Repo): RepoPolicy | null =>
  policies.find(p => matchGlob(p.id, `${repo.host}/${repo.fullName}`)) ?? null;

const ruleMatches = (rule: ProjectRule, project: Project) =>
  matchGlob(rule.match, project.name) || matchGlob(rule.match, project.dir);

export interface EffectiveRules {
  server: ProjectRule | null;         // first matching server rule
  repo: ProjectRule[];                // every matching repo rule
  requirements: Requirement[];
}

export const rulesFor = (project: Project, policy: RepoPolicy, repoConfig: RepoConfig): EffectiveRules => {
  const server = policy.projects?.find(r => ruleMatches(r, project)) ?? null;
  const repo = policy.allow_repo_config === false ? [] : repoConfig.rules.filter(r => ruleMatches(r, project));
  const requirements = new Set<Requirement>([
    ...(policy.apply_requirements ?? []),
    ...(server?.apply_requirements ?? []),
    ...(policy.allow_repo_config === false ? [] : repoConfig.apply_requirements),
    ...repo.flatMap(r => r.apply_requirements ?? []),
  ]);
  return { server, repo, requirements: [...requirements] };
};

// ---- CODEOWNERS -----------------------------------------------------------

const codeownersPattern = (raw: string): string => {
  let p = raw;
  const anchored = p.startsWith('/') || p.replace(/\/$/, '').includes('/');
  p = p.replace(/^\//, '');
  if (p.endsWith('/')) p += '**';
  if (!anchored) p = `**/${p}`;
  return p;
};

// Owners of the files in `dir`, as principals ("user:x", "team:org/y").
export const ownersFor = (codeowners: string, dir: string): Principal[] => {
  const sample = dir === '.' ? 'main.tf' : `${dir}/main.tf`;
  let owners: Principal[] = [];
  for (const raw of codeowners.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [pattern, ...who] = line.split(/\s+/);
    const glob = codeownersPattern(pattern);
    if (matchGlob(glob, sample) || matchGlob(`${glob}/**`, sample)) {
      // Last match wins, as on GitHub.
      owners = who.filter(o => o.startsWith('@')).map(o => (o.includes('/') ? `team:${o.slice(1)}` : `user:${o.slice(1)}`));
    }
  }
  return owners;
};

// ---- principals -----------------------------------------------------------

const atLeast = (have: Permission, need: Permission) =>
  PERMISSION_LEVELS.indexOf(have) >= PERMISSION_LEVELS.indexOf(need);

export const matchesPrincipal = async (principal: Principal, user: string, project: Project, lookup: Lookup): Promise<boolean> => {
  const p = principal.trim();
  if (p === 'anyone') return true;
  if ((PERMISSION_LEVELS as readonly string[]).includes(p)) return atLeast(await lookup.permission(user), p as Permission);
  if (p.startsWith('user:')) return p.slice(5).toLowerCase() === user.toLowerCase();
  if (p.startsWith('team:')) return lookup.inTeam(p.slice(5), user);
  if (p === 'codeowners') {
    const file = await lookup.codeowners();
    if (!file) return false;
    for (const owner of ownersFor(file, project.dir)) {
      if (await matchesPrincipal(owner, user, project, lookup)) return true;
    }
    return false;
  }
  return false; // unknown principals never grant access
};

const matchesAny = async (principals: Principal[], user: string, project: Project, lookup: Lookup) => {
  for (const p of principals) if (await matchesPrincipal(p, user, project, lookup)) return true;
  return false;
};

export interface Decision { allowed: boolean; reason: string }

export const checkPermission = async (
  action: Action, user: string, project: Project, rules: EffectiveRules, lookup: Lookup,
): Promise<Decision> => {
  const serverList = rules.server?.permissions?.[action] ?? DEFAULT_PERMISSIONS[action];
  if (!(await matchesAny(serverList, user, project, lookup))) {
    return { allowed: false, reason: `${action} on \`${project.name}\` needs ${serverList.join(' or ')}` };
  }
  for (const r of rules.repo) {
    const list = r.permissions?.[action];
    if (list && !(await matchesAny(list, user, project, lookup))) {
      return { allowed: false, reason: `${action} on \`${project.name}\` needs ${list.join(' or ')} (repo config)` };
    }
  }
  return { allowed: true, reason: 'allowed' };
};

// ---- approvals ------------------------------------------------------------

// Users whose current review is an approval of `headSha`, excluding the author.
export const currentApprovers = (reviews: Review[], author: string, headSha: string): string[] => {
  const latest = new Map<string, Review>();
  for (const r of reviews) {
    if (r.state === 'commented') continue; // comments don't change approval state
    latest.set(r.user.toLowerCase(), r);
  }
  return [...latest.values()]
    .filter(r => r.state === 'approved' && r.commitSha === headSha && r.user.toLowerCase() !== author.toLowerCase())
    .map(r => r.user);
};

export const approvalRules = (rules: EffectiveRules): ApprovalRule[] => {
  const list = [...(rules.server?.approvals ?? []), ...rules.repo.flatMap(r => r.approvals ?? [])];
  // "approved" alone means one approval from anyone else.
  if (rules.requirements.includes('approved') && list.length === 0) list.push({ from: 'anyone', count: 1 });
  return list;
};

export interface ApprovalStatus { ok: boolean; approvers: string[]; missing: string[] }

export const approvalStatus = async (
  project: Project, rules: EffectiveRules, approvers: string[], lookup: Lookup,
): Promise<ApprovalStatus> => {
  const missing: string[] = [];
  for (const rule of approvalRules(rules)) {
    let have = 0;
    for (const user of approvers) if (await matchesPrincipal(rule.from, user, project, lookup)) have++;
    if (have < rule.count) {
      const n = rule.count - have;
      missing.push(`${n} more approval${n > 1 ? 's' : ''} from ${rule.from === 'anyone' ? 'a reviewer' : rule.from}`);
    }
  }
  return { ok: missing.length === 0, approvers, missing };
};

export interface PrFacts { mergeable: boolean | null; behindBase: boolean }

// All apply requirements for a project; returns what is still missing.
export const applyBlockers = async (
  project: Project, rules: EffectiveRules, pr: PrFacts, approvers: string[], lookup: Lookup,
): Promise<string[]> => {
  const blockers: string[] = [];
  if (rules.requirements.includes('mergeable') && pr.mergeable !== true) blockers.push('PR is not mergeable');
  if (rules.requirements.includes('undiverged') && pr.behindBase) blockers.push('PR is behind the base branch; update it first');
  const approvals = await approvalStatus(project, rules, approvers, lookup);
  blockers.push(...approvals.missing);
  return blockers;
};
