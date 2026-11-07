// Repo-side config: tfv.yaml, or atlantis.yaml for easy migration.
// It can describe projects and add rules; policy.ts makes sure repo rules can
// only tighten what the server allows.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import type { ApprovalRule, ProjectRule, Requirement, Action, Principal, DriftSchedule } from './config.ts';
import { REQUIREMENTS, validateDrift } from './config.ts';
import type { Provider } from './tfv.ts';

export interface ProjectConfig {
  name?: string;
  dir: string;
  workspace?: string;
  engine?: Provider;
  version?: string;               // terraform / tofu version
  terragrunt_version?: string;
  autoplan?: boolean;
  when_modified?: string[];
  approvals?: ApprovalRule[];
  permissions?: Partial<Record<Action, Principal[]>>;
  apply_requirements?: Requirement[];
}

export interface RepoConfig {
  source: 'tfv.yaml' | 'atlantis.yaml' | null;
  autodiscover: boolean;
  projects: ProjectConfig[];
  apply_requirements: Requirement[];
  rules: ProjectRule[];           // tighten-only rules from the repo
  drift: DriftSchedule[];         // scheduled drift checks (tfv.yaml only)
  require_apply_project: boolean; // a repo can turn this on, never off
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

const parseTfv = (doc: Record<string, any>): RepoConfig => {
  const warnings: string[] = [];
  const projects: ProjectConfig[] = (doc.projects ?? []).map((p: Record<string, any>, i: number) => {
    const engine = p.engine === 'tofu' ? 'opentofu' : p.engine;
    if (engine && !ENGINES.includes(engine)) throw new Error(`projects[${i}].engine must be terraform, opentofu or terragrunt`);
    return {
      name: p.name, dir: cleanDir(p.dir), workspace: p.workspace, engine,
      version: p.version != null ? String(p.version) : undefined,
      terragrunt_version: p.terragrunt_version != null ? String(p.terragrunt_version) : undefined,
      autoplan: p.autoplan, when_modified: p.when_modified,
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
    source: 'tfv.yaml',
    autodiscover: doc.autodiscover !== false,
    projects,
    apply_requirements: requirements(doc.apply_requirements, 'apply_requirements', warnings),
    rules,
    drift: validateDrift(doc.drift, 'drift'),
    require_apply_project: doc.require_apply_project === true,
    warnings,
  };
};

const parseAtlantis = (doc: Record<string, any>): RepoConfig => {
  const warnings: string[] = [];
  if (doc.workflows) warnings.push('atlantis.yaml custom workflows are not run; tfv uses its built-in plan/apply steps');
  const projects: ProjectConfig[] = (doc.projects ?? []).map((p: Record<string, any>, i: number) => {
    if (p.workflow) warnings.push(`project ${p.name ?? p.dir}: workflow "${p.workflow}" ignored`);
    return {
      name: p.name, dir: cleanDir(p.dir), workspace: p.workspace,
      version: p.terraform_version != null ? String(p.terraform_version).replace(/^v/, '') : undefined,
      autoplan: p.autoplan?.enabled, when_modified: p.autoplan?.when_modified,
      apply_requirements: requirements(p.apply_requirements, `projects[${i}]`, warnings),
    };
  });
  // Atlantis only autodiscovers when no projects are listed (mode "auto").
  const mode = doc.autodiscover?.mode ?? 'auto';
  return {
    source: 'atlantis.yaml',
    autodiscover: mode === 'enabled' || (mode === 'auto' && projects.length === 0),
    projects,
    apply_requirements: [],
    rules: projects.filter(p => p.apply_requirements?.length)
      .map(p => ({ match: p.name ?? p.dir, apply_requirements: p.apply_requirements })),
    drift: [],
    require_apply_project: false,
    warnings,
  };
};

export const REPO_CONFIG_FILES = ['tfv.yaml', 'tfv.yml', 'atlantis.yaml', 'atlantis.yml'];

export const parseRepoConfig = (file: string, text: string): RepoConfig => {
  const doc = YAML.parse(text) ?? {};
  try {
    return file.startsWith('tfv') ? parseTfv(doc) : parseAtlantis(doc);
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
