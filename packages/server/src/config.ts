// Server configuration: environment variables plus the server-side repos.yaml
// policy file. Repo-side files (tfv.yaml / atlantis.yaml) are in repoConfig.ts.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { parseCron, validTimeZone } from './cron.ts';

export type Requirement = 'approved' | 'mergeable' | 'undiverged';
export const REQUIREMENTS: Requirement[] = ['approved', 'mergeable', 'undiverged'];

export type Action = 'plan' | 'apply' | 'apply_destroy' | 'unlock';
export const ACTIONS: Action[] = ['plan', 'apply', 'apply_destroy', 'unlock'];

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
}

export interface RepoPolicy {
  id: string;                                 // glob on "host/owner/name"
  apply_requirements?: Requirement[];
  allow_repo_config?: boolean;                // read tfv.yaml / atlantis.yaml (default true)
  allow_extra_args?: boolean;                 // `tfv plan -- -var=x` (default false)
  autoplan?: boolean;                         // default true
  plan_drafts?: boolean;                      // default false
  allow_repo_schedules?: boolean;             // drift schedules from tfv.yaml (default true)
  require_apply_project?: boolean;            // refuse a bare `tfv apply`; one project at a time
  allow_targets?: boolean;                    // `tfv plan -t <address>` (default true)
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
  runTimeoutMs: number;                       // per terraform command
  commandNames: string[];                     // comment prefixes, e.g. ["tfv", "atlantis"]
  defaultVersion: string;                     // when a project pins nothing
  requireApplyProject: boolean;               // TFV_REQUIRE_APPLY_PROJECT: no bare `tfv apply` anywhere
  github?: GitHubConfig;
  repos: RepoPolicy[];
  channels: Record<string, ChannelConfig>;
  people: Person[];
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
  const repos = parseReposYaml(text);
  for (const [i, r] of repos.entries()) {
    if (!r.drift) continue;
    if (/[*?]/.test(r.id)) throw new Error(`repos[${i}]: drift schedules need an exact repo id, not a glob ("${r.id}")`);
    validateDrift(r.drift, `repos[${i}].drift`, channels);
  }
  return { repos, channels, people };
};

export const parseReposYaml = (text: string): RepoPolicy[] => {
  const doc = YAML.parse(text) ?? {};
  const repos = asList<RepoPolicy>(doc.repos, 'repos');
  for (const [i, repo] of repos.entries()) {
    if (!repo || typeof repo.id !== 'string') throw new Error(`repos[${i}].id is required`);
    for (const r of repo.apply_requirements ?? []) {
      if (!REQUIREMENTS.includes(r)) throw new Error(`repos[${i}]: unknown apply requirement "${r}"`);
    }
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
  const dataDir = resolve(env.TFV_DATA_DIR || '/data');
  const port = Number(env.TFV_PORT || 8080);

  let policy: ServerPolicy = { repos: [], channels: {}, people: [] };
  const reposFile = env.TFV_REPOS_CONFIG || join(dataDir, 'repos.yaml');
  if (existsSync(reposFile)) policy = parseServerPolicy(readFileSync(reposFile, 'utf-8'));
  const repos = policy.repos;
  if (env.TFV_REPO_ALLOWLIST) {
    repos.push(...env.TFV_REPO_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id })));
  }
  // Safe default: a server that would run code from any repo is refused.
  if (repos.length === 0) {
    throw new Error('No repos allowed. Set TFV_REPO_ALLOWLIST (e.g. "github.com/acme/*") or provide repos.yaml');
  }

  let github: GitHubConfig | undefined;
  const appId = env.TFV_GITHUB_APP_ID;
  if (appId) {
    const privateKey = readSecret(env, 'TFV_GITHUB_PRIVATE_KEY');
    const webhookSecret = readSecret(env, 'TFV_GITHUB_WEBHOOK_SECRET');
    if (!privateKey || !webhookSecret) {
      throw new Error('TFV_GITHUB_PRIVATE_KEY and TFV_GITHUB_WEBHOOK_SECRET are required with TFV_GITHUB_APP_ID');
    }
    const apiUrl = (env.TFV_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
    const host = apiUrl === 'https://api.github.com' ? 'github.com' : new URL(apiUrl).host;
    github = { appId, privateKey: privateKey.replace(/\\n/g, '\n'), webhookSecret, apiUrl, host };
  }
  if (!github) throw new Error('No source-control platform configured (set TFV_GITHUB_APP_ID and friends)');

  const commandNames = ['tfv'];
  if (env.TFV_ATLANTIS_COMPAT !== 'false') commandNames.push('atlantis');

  return {
    port,
    dataDir,
    publicUrl: (env.TFV_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    parallelism: Math.max(1, Number(env.TFV_PARALLELISM || 4)),
    runTimeoutMs: Math.max(60, Number(env.TFV_RUN_TIMEOUT_SECONDS || 3600)) * 1000,
    commandNames,
    defaultVersion: env.TFV_DEFAULT_VERSION || 'latest',
    requireApplyProject: env.TFV_REQUIRE_APPLY_PROJECT === 'true',
    github,
    repos,
    channels: policy.channels,
    people: policy.people,
  };
};
