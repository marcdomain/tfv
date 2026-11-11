// Repo-side config: teriac.yaml.
// It can describe projects and add rules; policy.ts makes sure repo rules can
// only tighten what the server allows.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { ApprovalRule, ProjectRule, Requirement, Action, Principal, DriftSchedule } from './config.ts';
import { REQUIREMENTS, validateDrift } from './config.ts';
import type { Provider } from './teriac.ts';
import { validateStaleBase, type StaleBaseMode } from './safety-config.ts';

export interface ProjectConfig {
  name?: string;
  dir: string;
  workspace?: string;
  engine?: Provider;
  version?: string;               // terraform / tofu version
  terragrunt_version?: string;
  autoplan?: boolean;
  watch?: string[];               // extra files that should replan this project (globs; added to automatic detection)
  approvals?: ApprovalRule[];
  permissions?: Partial<Record<Action, Principal[]>>;
  apply_requirements?: Requirement[];
}

export interface RepoConfig {
  source: string | null;          // the file it came from (teriac.yaml or teriac.yml)
  autodiscover: boolean;
  projects: ProjectConfig[];
  apply_requirements: Requirement[];
  rules: ProjectRule[];           // tighten-only rules from the repo
  drift: DriftSchedule[];         // scheduled drift checks (teriac.yaml only)
  require_apply_project: boolean; // a repo can turn this on, never off
  reapprove_on_change?: boolean;  // a repo can turn this on, never off
  keep_approval_on_rebase?: boolean; // a repo can turn this off, never on
  stale_base?: StaleBaseMode;     // a repo can make this stricter
  warnings: string[];
}

const EMPTY: RepoConfig = { source: null, autodiscover: true, projects: [], apply_requirements: [], rules: [], drift: [], require_apply_project: false, warnings: [] };

const cleanDir = (dir: unknown): string => {
  const d = String(dir ?? '.').replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '');
  if (d.split('/').includes('..') || d.startsWith('/')) throw new Error(`project dir "${dir}" must stay inside the repo`);
  return d || '.';
};

const requirements = (list: unknown, where: string, warnings: string[]): Requirement[] =>
  (Array.isArray(list) ? list : []).filter((r): r is Requirement => {
    if (REQUIREMENTS.includes(r)) return true;
    warnings.push(`${where}: ignored unknown apply requirement "${r}"`);
    return false;
  });

const ENGINES: Provider[] = ['terraform', 'opentofu', 'terragrunt'];

const parseConfig = (doc: Record<string, any>): RepoConfig => {
  const warnings: string[] = [];
  const projects: ProjectConfig[] = (doc.projects ?? []).map((p: Record<string, any>, i: number) => {
    const engine = p.engine === 'tofu' ? 'opentofu' : p.engine;
    if (engine && !ENGINES.includes(engine)) throw new Error(`projects[${i}].engine must be terraform, opentofu or terragrunt`);
    return {
      name: p.name, dir: cleanDir(p.dir), workspace: p.workspace, engine,
      version: p.version != null ? String(p.version) : undefined,
      terragrunt_version: p.terragrunt_version != null ? String(p.terragrunt_version) : undefined,
      autoplan: p.autoplan, watch: Array.isArray(p.watch) ? p.watch.map(String) : undefined,
      approvals: p.approvals, permissions: p.permissions,
      apply_requirements: requirements(p.apply_requirements, `projects[${i}]`, warnings),
    };
  });
  const rules: ProjectRule[] = [
    ...(doc.rules ?? []),
    // Per-project rules match the project's name (or dir).
    ...projects.filter(p => p.approvals || p.permissions || p.apply_requirements?.length)
      .map(p => ({ match: p.name ?? p.dir, approvals: p.approvals, permissions: p.permissions, apply_requirements: p.apply_requirements })),
  ];
  return {
    source: 'teriac.yaml',
    autodiscover: doc.autodiscover !== false,
    projects,
    apply_requirements: requirements(doc.apply_requirements, 'apply_requirements', warnings),
    rules,
    drift: validateDrift(doc.drift, 'drift'),
    require_apply_project: doc.require_apply_project === true,
    // Tighten-only: teriac.yaml can ask for fresh approvals and stricter base checks, never loosen them.
    reapprove_on_change: doc.reapprove_on_change === true ? true : undefined,
    keep_approval_on_rebase: doc.keep_approval_on_rebase === false ? false : undefined,
    stale_base: validateStaleBase(doc.stale_base, 'stale_base'),
    warnings,
  };
};

export const REPO_CONFIG_FILES = ['teriac.yaml', 'teriac.yml'];

export const parseRepoConfig = (file: string, text: string): RepoConfig => {
  const doc = YAML.parse(text) ?? {};
  try {
    return { ...parseConfig(doc), source: file };
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`);
  }
};

export const emptyRepoConfig = (): RepoConfig => ({ ...EMPTY, projects: [], rules: [], drift: [], warnings: [] });

// From a checkout (the PR head: which projects exist).
export const loadRepoConfig = (root: string): RepoConfig => {
  for (const file of REPO_CONFIG_FILES) {
    const path = join(root, file);
    if (existsSync(path)) return parseRepoConfig(file, readFileSync(path, 'utf-8'));
  }
  return emptyRepoConfig();
};

// From any source, e.g. the base branch via the platform API (which rules apply).
export const loadRepoConfigFrom = async (read: (file: string) => Promise<string | null>): Promise<RepoConfig> => {
  for (const file of REPO_CONFIG_FILES) {
    const text = await read(file);
    if (text !== null) return parseRepoConfig(file, text);
  }
  return emptyRepoConfig();
};
