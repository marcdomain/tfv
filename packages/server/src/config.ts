// Server configuration: environment variables plus the server-side repos.yaml
// policy file. The repo-side teriac.yaml is in repoConfig.ts.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { parseCron, validTimeZone } from './cron.ts';
import { parseBackup, type BackupConfig } from './backup.ts';
import { randomBytes } from 'node:crypto';
import type { AuthConfig, DashboardUser } from './auth.ts';
import { REACTIONS, type Ack } from './vcs/types.ts';
import { validatePolicies, type PolicyConfig } from './policies.ts';
import {
  validateSecretScan, validateRisk, validateFreezes, validateProtected, validateBreakGlass, validateSummary,
  validateStaleBase, validateBool,
  type SecretScanConfig, type SecretScanMode, type RiskConfig, type FreezeConfig, type ProtectedConfig,
  type BreakGlassConfig, type SummaryConfig, type StaleBaseMode,
} from './safety-config.ts';

export type Requirement = 'approved' | 'mergeable' | 'undiverged';
export const REQUIREMENTS: Requirement[] = ['approved', 'mergeable', 'undiverged'];

// One key per Terraform command, so a project can single out a command ("everything but force-unlock").
export type CommandAction = 'state_list' | 'state_show' | 'show' | 'output' | 'validate' | 'providers' | 'fmt'
  | 'import' | 'taint' | 'untaint' | 'state_rm' | 'state_mv' | 'force_unlock';
export const COMMAND_ACTIONS: CommandAction[] = ['state_list', 'state_show', 'show', 'output', 'validate', 'providers', 'fmt',
  'import', 'taint', 'untaint', 'state_rm', 'state_mv', 'force_unlock'];
export type Action = 'plan' | 'apply' | 'apply_destroy' | 'unlock' | 'state_read' | 'state_write' | 'state_remove' | CommandAction;
export const ACTIONS: Action[] = ['plan', 'apply', 'apply_destroy', 'unlock', 'state_read', 'state_write', 'state_remove', ...COMMAND_ACTIONS];

// Principal strings: "write" (minimum repo permission), "team:platform" or
// "team:org/platform", "user:alice", "codeowners", "anyone".
export type Principal = string;

export interface ApprovalRule {
  from: Principal;
  count: number;
}

export interface ProjectRule {
  match: string;                              // glob on project dir or name
  permissions?: Partial<Record<Action, Principal[]>>;
  approvals?: ApprovalRule[];
  apply_requirements?: Requirement[];
  two_person_rule?: boolean;                  // the PR author may not apply
}

export interface RepoPolicy {
  id: string;                                 // glob on "host/owner/name"
  apply_requirements?: Requirement[];
  allow_repo_config?: boolean;                // read the repo's teriac.yaml (default true)
  allow_extra_args?: boolean;                 // `teriac plan -- -var=x` (default false)
  autoplan?: boolean;                         // default true
  plan_drafts?: boolean;                      // default false
  allow_repo_schedules?: boolean;             // drift schedules from teriac.yaml (default true)
  require_apply_project?: boolean;            // refuse a bare `teriac apply`; one project at a time
  allow_targets?: boolean;                    // `teriac plan -t <address>` (default true)
  allow_state_changes?: boolean;              // direct state edits: import, taint, state rm/mv, force-unlock (default true)
  ack_reaction?: Ack;                         // reaction on a command teriac picked up (default: server setting)
  progress_reply?: boolean;                   // spinning "Running…" reply under the command (default: server setting)
  two_person_rule?: boolean;                  // the PR author may not apply (any project in the repo)
  policies?: PolicyConfig;                    // extra policy rules / stricter mode for this repo
  comment_mode?: 'new' | 'update';            // new comment per plan, or one comment edited in place
  // Approvals and out-of-date branches.
  reapprove_on_change?: boolean;              // default true: a code change needs a fresh approval
  keep_approval_on_rebase?: boolean;          // default false: a rebase (same changes) keeps approvals
  stale_base?: StaleBaseMode;                 // default warn: base changed files this project uses
  verify_plan?: boolean;                      // default true: apply only the exact plan file reviewed
  secret_scan?: SecretScanMode;               // stricter than the server's mode, never looser
  risk?: RiskConfig;
  freezes?: FreezeConfig;
  protected?: ProtectedConfig;
  projects?: ProjectRule[];
  drift?: DriftSchedule[];                    // server-side schedules (id must be one repo)
}

// ---- drift detection ----

export interface DriftSchedule {
  name?: string;
  projects: string[];                         // globs on project name or dir
  branch?: string;                            // default: the repo's default branch
  schedule: string;                           // cron
  timezone?: string;                          // IANA name, default UTC
  notify: string[];                           // channel names from repos.yaml
  notify_when?: 'changed' | 'always';         // default "changed"
  include_pending?: boolean;                  // also report merged-but-unapplied changes (default true)
  fix_pr?: boolean;                           // open a PR that updates the code to match (default false)
}

export type ChannelType = 'slack' | 'teams' | 'discord' | 'googlechat' | 'webhook';
export const CHANNEL_TYPES: ChannelType[] = ['slack', 'teams', 'discord', 'googlechat', 'webhook'];

export interface ChannelConfig {
  type: ChannelType;
  channel?: string;                           // Slack channel ID or name (bot token mode)
  token_env?: string;                         // env var holding a Slack bot token
  webhook_url_env?: string;                   // env var holding a webhook URL
}

// Maps code and platform identities to chat handles for @mentions.
export interface Person {
  name?: string;
  github?: string;
  emails?: string[];
  slack?: string;                             // Slack member ID, e.g. U0123ABC
  teams?: string;                             // Teams UPN, e.g. alice@acme.onmicrosoft.com
  discord?: string;                           // Discord user ID
}

export interface ServerPolicy {
  repos: RepoPolicy[];
  channels: Record<string, ChannelConfig>;
  people: Person[];
  users: DashboardUser[];                     // dashboard username/password sign-in
  policies?: PolicyConfig;                    // policy checks for every repo
  secretScan?: SecretScanConfig;
  risk?: RiskConfig;
  freezes?: FreezeConfig;
  protected?: ProtectedConfig;
  breakGlass?: BreakGlassConfig;
  summary?: SummaryConfig;
}

export interface GitHubConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  apiUrl: string;
  host: string;
}

export interface ServerConfig {
  port: number;
  dataDir: string;
  publicUrl: string;
  parallelism: number;
  prParallelism?: number;                     // TERIAC_PR_PARALLELISM: one PR's share (default parallelism - 1)
  runTimeoutMs: number;                       // per terraform command
  commandNames: string[];                     // comment prefixes, e.g. ["teriac"]
  defaultVersion: string;                     // when a project pins nothing
  requireApplyProject: boolean;               // TERIAC_REQUIRE_APPLY_PROJECT: no bare `teriac apply` anywhere
  ackReaction: Ack;                           // TERIAC_ACK_REACTION: reaction on the command (default eyes), or none
  progressReply: boolean;                     // TERIAC_PROGRESS_REPLY: spinning "Running…" reply, edited into the result (default off)
  commentMode: 'new' | 'update';              // TERIAC_COMMENT_MODE: a new comment per plan (default) or one updated comment
  spinnerUrl: string | null;                  // animated icon GitHub can load; null → fall back to 👀
  github?: GitHubConfig;
  repos: RepoPolicy[];
  channels: Record<string, ChannelConfig>;
  people: Person[];
  auth: AuthConfig;
  policies?: PolicyConfig;
  secretScan?: SecretScanConfig;
  risk?: RiskConfig;
  freezes?: FreezeConfig;
  protected?: ProtectedConfig;
  breakGlass?: BreakGlassConfig;
  summary?: SummaryConfig;
  backup?: BackupConfig;                  // scheduled database backups (TERIAC_BACKUP_*)
}

const readSecret = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf-8').trim();
  return env[name];
};

const asList = <T>(value: unknown, field: string): T[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be a list`);
  return value as T[];
};

export const parseReaction = (value: unknown, where: string): Ack | undefined => {
  if (value === undefined || value === '') return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === 'none' || (REACTIONS as readonly string[]).includes(v)) return v as Ack;
  throw new Error(`${where} must be one of ${REACTIONS.join(', ')}, or none (got "${value}")`);
};

// GitHub fetches images in comments itself, so the spinner needs a public https address.
export const spinnerUrlFor = (publicUrl: string): string | null => {
  try {
    const u = new URL(publicUrl);
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(u.hostname) || u.hostname.endsWith('.local');
    return u.protocol === 'https:' && !local ? `${publicUrl.replace(/\/+$/, '')}/assets/spinner.gif` : null;
  } catch {
    return null;
  }
};

export const parseCommentMode = (value: unknown, where: string): 'new' | 'update' | undefined => {
  if (value === undefined || value === '') return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === 'new' || v === 'update') return v;
  throw new Error(`${where} must be "new" (a comment per plan) or "update" (one comment edited in place), got "${value}"`);
};

export const validateDrift = (list: unknown, where: string, channels?: Record<string, ChannelConfig>): DriftSchedule[] => {
  const schedules = asList<DriftSchedule>(list, where);
  for (const [i, d] of schedules.entries()) {
    const at = `${where}[${i}]`;
    if (!d || typeof d.schedule !== 'string') throw new Error(`${at}.schedule is required (cron)`);
    parseCron(d.schedule);
    if (d.timezone && !validTimeZone(d.timezone)) throw new Error(`${at}.timezone "${d.timezone}" is not a known time zone`);
    if (!Array.isArray(d.projects) || !d.projects.length) throw new Error(`${at}.projects needs at least one project or glob`);
    if (!Array.isArray(d.notify) || !d.notify.length) throw new Error(`${at}.notify needs at least one channel`);
    if (d.notify_when && !['changed', 'always'].includes(d.notify_when)) throw new Error(`${at}.notify_when must be "changed" or "always"`);
    validateBool(d.fix_pr, `${at}.fix_pr`);
    if (channels) {
      for (const c of d.notify) if (!channels[c]) throw new Error(`${at}.notify: no channel named "${c}" in repos.yaml`);
    }
  }
  return schedules;
};

export const parseServerPolicy = (text: string): ServerPolicy => {
  const doc = YAML.parse(text) ?? {};
  const channels: Record<string, ChannelConfig> = doc.channels ?? {};
  for (const [name, c] of Object.entries(channels)) {
    if (!c || !CHANNEL_TYPES.includes(c.type)) throw new Error(`channels.${name}.type must be one of ${CHANNEL_TYPES.join(', ')}`);
    if (c.type === 'slack' && !(c.token_env && c.channel) && !c.webhook_url_env) {
      throw new Error(`channels.${name}: Slack needs token_env + channel (recommended, enables @mentions by email) or webhook_url_env`);
    }
    if (c.type !== 'slack' && !c.webhook_url_env) throw new Error(`channels.${name}.webhook_url_env is required`);
  }
  const people = asList<Person>(doc.people, 'people');
  const users = parseUsers(doc.dashboard?.users, 'dashboard.users');
  const repos = parseReposYaml(text);
  for (const [i, r] of repos.entries()) {
    if (!r.drift) continue;
    if (/[*?]/.test(r.id)) throw new Error(`repos[${i}]: drift schedules need an exact repo id, not a glob ("${r.id}")`);
    validateDrift(r.drift, `repos[${i}].drift`, channels);
  }
  const policies = validatePolicies(doc.policies, 'policies');
  for (const [i, r] of repos.entries()) r.policies = validatePolicies(r.policies, `repos[${i}].policies`);
  return {
    repos, channels, people, users, policies,
    secretScan: validateSecretScan(doc.secret_scan, 'secret_scan'),
    risk: validateRisk(doc.risk, 'risk'),
    freezes: validateFreezes(doc.freezes, 'freezes'),
    protected: validateProtected(doc.protected, 'protected'),
    breakGlass: validateBreakGlass(doc.break_glass, 'break_glass', channels),
    summary: validateSummary(doc.summary, 'summary', channels),
  };
};

export const parseUsers = (list: unknown, where: string): DashboardUser[] => {
  const users = asList<DashboardUser>(list, where);
  for (const [i, u] of users.entries()) {
    if (!u?.username || !u.password_hash?.startsWith('scrypt$')) {
      throw new Error(`${where}[${i}] needs a username and a password_hash from "node packages/server/src/hash-password.ts"`);
    }
    if (u.role && !['admin', 'viewer'].includes(u.role)) throw new Error(`${where}[${i}].role must be admin or viewer`);
  }
  return users;
};

const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);

export const loadAuth = (env: NodeJS.ProcessEnv, publicUrl: string, users: DashboardUser[]): AuthConfig => {
  const usersFile = env.TERIAC_DASHBOARD_USERS_FILE;
  if (usersFile) users = [...users, ...parseUsers(YAML.parse(readFileSync(usersFile, 'utf-8')), usersFile)];
  let oidc: AuthConfig['oidc'];
  if (env.TERIAC_OIDC_ISSUER) {
    const clientSecret = readSecret(env, 'TERIAC_OIDC_CLIENT_SECRET');
    if (!env.TERIAC_OIDC_CLIENT_ID || !clientSecret) throw new Error('TERIAC_OIDC_CLIENT_ID and TERIAC_OIDC_CLIENT_SECRET are required with TERIAC_OIDC_ISSUER');
    oidc = {
      issuer: env.TERIAC_OIDC_ISSUER.replace(/\/+$/, ''),
      clientId: env.TERIAC_OIDC_CLIENT_ID,
      clientSecret,
      name: env.TERIAC_OIDC_NAME || (/okta(preview)?\.com/.test(env.TERIAC_OIDC_ISSUER) ? 'Okta' : 'single sign-on'),
      scopes: list(env.TERIAC_OIDC_SCOPES || 'openid,profile,email,groups'),
      groupsClaim: env.TERIAC_OIDC_GROUPS_CLAIM || 'groups',
      adminGroups: list(env.TERIAC_OIDC_ADMIN_GROUPS),
      allowedGroups: list(env.TERIAC_OIDC_ALLOWED_GROUPS),
    };
  }
  const sessionSecret = readSecret(env, 'TERIAC_SESSION_SECRET');
  if (sessionSecret && sessionSecret.length < 32) throw new Error('TERIAC_SESSION_SECRET must be at least 32 characters');
  return {
    apiToken: readSecret(env, 'TERIAC_API_TOKEN'),
    // Without a fixed secret, sessions end when the server restarts.
    sessionSecret: sessionSecret || randomBytes(32).toString('hex'),
    sessionHours: Math.max(1, Number(env.TERIAC_SESSION_HOURS || 12)),
    secureCookies: publicUrl.startsWith('https://'),
    users,
    oidc,
  };
};

export const parseReposYaml = (text: string): RepoPolicy[] => {
  const doc = YAML.parse(text) ?? {};
  const repos = asList<RepoPolicy>(doc.repos, 'repos');
  for (const [i, repo] of repos.entries()) {
    if (!repo || typeof repo.id !== 'string') throw new Error(`repos[${i}].id is required`);
    if (repo.ack_reaction !== undefined) repo.ack_reaction = parseReaction(repo.ack_reaction, `repos[${i}].ack_reaction`);
    if (repo.comment_mode !== undefined) repo.comment_mode = parseCommentMode(repo.comment_mode, `repos[${i}].comment_mode`);
    for (const r of repo.apply_requirements ?? []) {
      if (!REQUIREMENTS.includes(r)) throw new Error(`repos[${i}]: unknown apply requirement "${r}"`);
    }
    const at = `repos[${i}]`;
    validateBool(repo.reapprove_on_change, `${at}.reapprove_on_change`);
    validateBool(repo.keep_approval_on_rebase, `${at}.keep_approval_on_rebase`);
    validateBool(repo.verify_plan, `${at}.verify_plan`);
    validateStaleBase(repo.stale_base, `${at}.stale_base`);
    if (repo.secret_scan !== undefined) repo.secret_scan = validateSecretScan(repo.secret_scan, `${at}.secret_scan`)?.mode;
    validateRisk(repo.risk, `${at}.risk`);
    validateFreezes(repo.freezes, `${at}.freezes`);
    validateProtected(repo.protected, `${at}.protected`);
    for (const [j, p] of asList<ProjectRule>(repo.projects, `repos[${i}].projects`).entries()) {
      if (typeof p.match !== 'string') throw new Error(`repos[${i}].projects[${j}].match is required`);
      for (const action of Object.keys(p.permissions ?? {})) {
        if (!ACTIONS.includes(action as Action)) throw new Error(`repos[${i}].projects[${j}]: unknown action "${action}"`);
      }
      for (const a of p.approvals ?? []) {
        if (typeof a.from !== 'string' || !(a.count >= 1)) {
          throw new Error(`repos[${i}].projects[${j}].approvals: each needs "from" and "count" >= 1`);
        }
      }
    }
  }
  return repos;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): ServerConfig => {
  const dataDir = resolve(env.TERIAC_DATA_DIR || '/data');
  const port = Number(env.TERIAC_PORT || 8080);

  let policy: ServerPolicy = { repos: [], channels: {}, people: [], users: [] };
  const reposFile = env.TERIAC_REPOS_CONFIG || join(dataDir, 'repos.yaml');
  // An explicitly configured file must be readable; only the default may be absent.
  if (env.TERIAC_REPOS_CONFIG || existsSync(reposFile)) {
    let text: string;
    try {
      text = readFileSync(reposFile, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(`cannot read TERIAC_REPOS_CONFIG (${reposFile}): ${code === 'EACCES' ? 'permission denied' : code === 'ENOENT' ? 'file not found' : (err as Error).message}`);
    }
    try {
      policy = parseServerPolicy(text);
    } catch (err) {
      throw new Error(`${reposFile}: ${(err as Error).message}`);
    }
  }
  const repos = policy.repos;
  if (env.TERIAC_REPO_ALLOWLIST) {
    repos.push(...env.TERIAC_REPO_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id })));
  }
  // Safe default: a server that would run code from any repo is refused.
  if (repos.length === 0) {
    throw new Error('No repos allowed. Set TERIAC_REPO_ALLOWLIST (e.g. "github.com/acme/*") or provide repos.yaml');
  }

  let github: GitHubConfig | undefined;
  const appId = env.TERIAC_GITHUB_APP_ID;
  if (appId) {
    const privateKey = readSecret(env, 'TERIAC_GITHUB_PRIVATE_KEY');
    const webhookSecret = readSecret(env, 'TERIAC_GITHUB_WEBHOOK_SECRET');
    if (!privateKey || !webhookSecret) {
      throw new Error('TERIAC_GITHUB_PRIVATE_KEY and TERIAC_GITHUB_WEBHOOK_SECRET are required with TERIAC_GITHUB_APP_ID');
    }
    const apiUrl = (env.TERIAC_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    const host = apiUrl === 'https://api.github.com' ? 'github.com' : new URL(apiUrl).host;
    github = { appId, privateKey: privateKey.replace(/\\n/g, '\n'), webhookSecret, apiUrl, host };
  }
  if (!github) throw new Error('No source-control platform configured (set TERIAC_GITHUB_APP_ID and friends)');

  const commandNames = ['teriac'];

  const publicUrl = (env.TERIAC_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  return {
    port,
    dataDir,
    publicUrl,
    parallelism: Math.max(1, Number(env.TERIAC_PARALLELISM || 4)),
    prParallelism: env.TERIAC_PR_PARALLELISM ? Math.max(1, Number(env.TERIAC_PR_PARALLELISM)) : undefined,
    runTimeoutMs: Math.max(60, Number(env.TERIAC_RUN_TIMEOUT_SECONDS || 3600)) * 1000,
    commandNames,
    defaultVersion: env.TERIAC_DEFAULT_VERSION || 'latest',
    requireApplyProject: env.TERIAC_REQUIRE_APPLY_PROJECT === 'true',
    ackReaction: parseReaction(env.TERIAC_ACK_REACTION, 'TERIAC_ACK_REACTION') ?? 'eyes',
    progressReply: env.TERIAC_PROGRESS_REPLY === 'true',
    commentMode: parseCommentMode(env.TERIAC_COMMENT_MODE, 'TERIAC_COMMENT_MODE') ?? 'new',
    spinnerUrl: spinnerUrlFor(publicUrl),
    github,
    repos,
    channels: policy.channels,
    people: policy.people,
    policies: policy.policies,
    secretScan: policy.secretScan,
    risk: policy.risk,
    freezes: policy.freezes,
    protected: policy.protected,
    breakGlass: policy.breakGlass,
    summary: policy.summary,
    backup: parseBackup({ ...env, TERIAC_BACKUP_AZURE_KEY: readSecret(env, 'TERIAC_BACKUP_AZURE_KEY') }, policy.channels),
    auth: loadAuth(env, publicUrl, policy.users),
  };
};
