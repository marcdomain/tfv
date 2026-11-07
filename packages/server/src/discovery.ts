// Finds terraform / opentofu / terragrunt projects in a checkout and works
// out which ones a PR affects. No config needed; tfv.yaml / atlantis.yaml
// projects are merged on top.
import { readdirSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { RepoConfig, ProjectConfig } from './repoConfig.ts';
import type { Provider } from './tfv.ts';
import { tfv } from './tfv.ts';
import { matchGlob } from './glob.ts';

export interface Project {
  name: string;
  dir: string;                    // repo-relative, "." for the root
  workspace: string;
  engine: Provider;               // terragrunt, or the plain tool
  tool: 'terraform' | 'opentofu'; // what actually plans (terragrunt drives it)
  autoplan: boolean;
  whenModified?: string[];
  version?: string;
  terragruntVersion?: string;
  deps: string[];                 // repo-relative dirs/files whose changes affect it
}

const SKIP_DIRS = new Set(['.git', '.terraform', '.terragrunt-cache', 'node_modules']);
const MAX_DEPTH = 25;
const VERSION_FILES = ['.terraform-version', '.opentofu-version', '.tofu-version', '.terragrunt-version', '.tool-versions', '.tfswitchrc', '.tfswitch.toml', '.tgswitchrc'];

interface DirInfo {
  dir: string;
  tfFiles: string[];
  hasTofuFiles: boolean;
  terragrunt: string | null;      // terragrunt.hcl content
  hasChildTerragrunt: boolean;
}

const toPosix = (p: string) => p.split('\\').join('/');
const parentDirs = (dir: string): string[] => {
  const out: string[] = [];
  let d = dir;
  while (d !== '.') { d = posix.dirname(d); out.push(d); }
  return out;
};

// Resolves a relative path written in `fromDir`; null if it leaves the repo.
const resolveRel = (fromDir: string, rel: string): string | null => {
  const joined = posix.normalize(posix.join(fromDir, rel.replace(/\/\/+/g, '/')));
  if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) return null;
  return joined.replace(/\/+$/, '') || '.';
};

const walk = (root: string): Map<string, DirInfo> => {
  const dirs = new Map<string, DirInfo>();
  const visit = (rel: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    const abs = rel === '.' ? root : join(root, rel);
    const entries = readdirSync(abs, { withFileTypes: true });
    const info: DirInfo = { dir: rel, tfFiles: [], hasTofuFiles: false, terragrunt: null, hasChildTerragrunt: false };
    for (const e of entries) {
      // Never follow symlinks: a PR could point one outside the checkout.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        visit(rel === '.' ? e.name : `${rel}/${e.name}`, depth + 1);
      } else if (e.isFile()) {
        if (e.name.endsWith('.tf') || e.name.endsWith('.tofu')) info.tfFiles.push(e.name);
        if (e.name.endsWith('.tofu')) info.hasTofuFiles = true;
        if (e.name === 'terragrunt.hcl') info.terragrunt = readFileSync(join(abs, e.name), 'utf-8');
      }
    }
    dirs.set(rel, info);
  };
  visit('.', 0);
  for (const info of dirs.values()) {
    if (!info.terragrunt) continue;
    for (const p of parentDirs(info.dir)) {
      const parent = dirs.get(p);
      if (parent) parent.hasChildTerragrunt = true;
    }
  }
  return dirs;
};

const LOCAL_SOURCE = /source\s*=\s*"(\.{1,2}\/[^"?]*)/g;
const CONFIG_PATH = /config_path\s*=\s*"([^"]+)"/g;
const DEP_PATHS = /paths\s*=\s*\[([^\]]*)\]/g;
const RELATIVE_FILE = /"(\.{1,2}\/[^"]+\.(?:hcl|tfvars|json|ya?ml))"/g;

const allMatches = (re: RegExp, text: string): string[] => [...text.matchAll(re)].map(m => m[1]);

// Local module dirs used by a directory's .tf files (or terragrunt source).
const moduleSources = (root: string, info: DirInfo): string[] => {
  const out: string[] = [];
  for (const f of info.tfFiles) {
    const text = readFileSync(join(root, info.dir, f), 'utf-8');
    for (const s of allMatches(LOCAL_SOURCE, text)) {
      const r = resolveRel(info.dir, s);
      if (r) out.push(r);
    }
  }
  if (info.terragrunt) {
    for (const s of allMatches(LOCAL_SOURCE, info.terragrunt)) {
      const r = resolveRel(info.dir, s);
      if (r) out.push(r);
    }
  }
  return out;
};

const hasBackend = (root: string, info: DirInfo): boolean =>
  info.tfFiles.some(f => /^\s*(backend\s+"|cloud\s*\{)/m.test(readFileSync(join(root, info.dir, f), 'utf-8')));

// Does a version file in `dir` or above pick OpenTofu?
const prefersTofu = (root: string, dir: string, terragrunt: string | null): boolean => {
  if (terragrunt && /terraform_binary\s*=\s*"tofu"/.test(terragrunt)) return true;
  for (const d of [dir, ...parentDirs(dir)]) {
    const abs = d === '.' ? root : join(root, d);
    const tofu = tfv().findVersionFile(abs, 'opentofu', { strict: true });
    if (tofu) return true;
    if (tfv().findVersionFile(abs, 'terraform', { strict: true })) return false;
  }
  return false;
};

export const discoverProjects = (root: string, repoConfig: RepoConfig): Project[] => {
  const dirs = walk(root);

  // Every local module dir, and what each dir pulls in.
  const referenced = new Set<string>();
  const sources = new Map<string, string[]>();
  for (const info of dirs.values()) {
    const s = moduleSources(root, info);
    sources.set(info.dir, s);
    s.forEach(d => referenced.add(d));
  }

  // Transitive local module dirs for a project dir.
  const moduleClosure = (dir: string): string[] => {
    const seen = new Set<string>();
    const stack = [...(sources.get(dir) ?? [])];
    while (stack.length) {
      const d = stack.pop()!;
      if (seen.has(d)) continue;
      seen.add(d);
      stack.push(...(sources.get(d) ?? []));
    }
    return [...seen];
  };

  const found = new Map<string, Project>();
  if (repoConfig.autodiscover) {
    for (const info of dirs.values()) {
      const isTerragrunt = info.terragrunt !== null
        // A parent terragrunt.hcl with no terraform block only holds shared config.
        && !(info.hasChildTerragrunt && !/terraform\s*\{/.test(info.terragrunt) && info.tfFiles.length === 0);
      const isPlain = !info.terragrunt && info.tfFiles.length > 0 && !referenced.has(info.dir)
        // Unused modules in a "modules" folder are libraries, not deployments.
        && !(info.dir.split('/').includes('modules') && !hasBackend(root, info));
      if (!isTerragrunt && !isPlain) continue;

      const deps = new Set(moduleClosure(info.dir));
      if (info.terragrunt) {
        for (const p of allMatches(CONFIG_PATH, info.terragrunt)) {
          const r = resolveRel(info.dir, p);
          if (r) deps.add(r);
        }
        for (const list of allMatches(DEP_PATHS, info.terragrunt)) {
          for (const p of allMatches(/"([^"]+)"/g, list)) {
            const r = resolveRel(info.dir, p);
            if (r) deps.add(r);
          }
        }
        for (const p of allMatches(RELATIVE_FILE, info.terragrunt)) {
          const r = resolveRel(info.dir, p);
          if (r) deps.add(r);
        }
      }

      const tool = prefersTofu(root, info.dir, info.terragrunt) || info.hasTofuFiles ? 'opentofu' : 'terraform';
      found.set(`${info.dir}::default`, {
        name: info.dir,
        dir: info.dir,
        workspace: 'default',
        engine: isTerragrunt ? 'terragrunt' : tool,
        tool,
        autoplan: true,
        deps: [...deps],
      });
    }
  }

  // Configured projects override discovered ones in the same dir + workspace.
  for (const pc of repoConfig.projects) {
    const workspace = pc.workspace ?? 'default';
    const key = `${pc.dir}::${workspace}`;
    const base = found.get(key) ?? found.get(`${pc.dir}::default`);
    const info = dirs.get(pc.dir);
    const tool = pc.engine === 'opentofu' ? 'opentofu'
      : pc.engine === 'terraform' ? 'terraform'
      : base?.tool ?? (prefersTofu(root, pc.dir, info?.terragrunt ?? null) ? 'opentofu' : 'terraform');
    found.set(key, {
      name: pc.name ?? (workspace === 'default' ? pc.dir : `${pc.dir}@${workspace}`),
      dir: pc.dir,
      workspace,
      engine: pc.engine ?? base?.engine ?? (info?.terragrunt ? 'terragrunt' : tool),
      tool,
      autoplan: pc.autoplan ?? true,
      whenModified: pc.when_modified,
      version: pc.version,
      terragruntVersion: pc.terragrunt_version,
      deps: base?.deps ?? (info ? moduleClosure(pc.dir) : []),
    });
  }

  const projects = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  const names = new Set<string>();
  for (const p of projects) {
    if (names.has(p.name)) throw new Error(`two projects are named "${p.name}"; give them unique names in tfv.yaml`);
    names.add(p.name);
  }
  return projects;
};

const within = (file: string, dir: string) => dir === '.' || file === dir || file.startsWith(`${dir}/`);

/**
 * Projects affected by the changed files. Terragrunt dependencies cascade:
 * if vpc changes, everything that depends on vpc is planned too.
 */
export const affectedProjects = (projects: Project[], changedFiles: string[]): Project[] => {
  const files = changedFiles.map(toPosix);
  const projectDirs = projects.map(p => p.dir);

  // The deepest project dir owns a file; nested projects don't trigger parents.
  const owner = (file: string): string | null => {
    let best: string | null = null;
    for (const d of projectDirs) {
      if (within(file, d) && (best === null || d.length > best.length || best === '.')) best = d;
    }
    return best;
  };

  const direct = (p: Project): boolean => files.some(f => {
    if (p.whenModified?.length) {
      const rel = posix.relative(p.dir === '.' ? '' : p.dir, f);
      return p.whenModified.some(g => matchGlob(g.replace(/^\.\//, ''), rel));
    }
    if (within(f, p.dir) && owner(f) === p.dir) return true;
    if (p.deps.some(d => within(f, d))) return true;
    // Version pins and shared terragrunt config in parent folders.
    const name = posix.basename(f);
    const fileDir = posix.dirname(f) === '' ? '.' : posix.dirname(f);
    if (fileDir !== p.dir && within(p.dir, fileDir)) {
      if (VERSION_FILES.includes(name)) return true;
      if (p.engine === 'terragrunt' && /\.(hcl|ya?ml|json)$/.test(name)) return true;
    }
    return false;
  });

  const hit = new Set(projects.filter(p => p.autoplan && direct(p)).map(p => p.name));
  // Cascade through terragrunt dependencies until nothing new is added.
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of projects) {
      if (hit.has(p.name) || !p.autoplan) continue;
      if (projects.some(q => hit.has(q.name) && p.deps.includes(q.dir))) {
        hit.add(p.name);
        grew = true;
      }
    }
  }
  return projects.filter(p => hit.has(p.name));
};

// Files changed under the project dir only matter if the dir still exists.
export const projectExists = (root: string, p: Project): boolean => {
  const abs = p.dir === '.' ? root : join(root, p.dir);
  return existsSync(abs) && lstatSync(abs).isDirectory();
};
