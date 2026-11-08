// Finds terraform / opentofu / terragrunt projects in a checkout and works
// out which ones a PR affects. No config needed; tfv.yaml projects are
// merged on top.
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
  watch: string[];                // repo-relative globs that also replan this project
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
  return out;
};

// ---- Terragrunt references ----------------------------------------------------
// What a unit's config pulls in: dependencies, includes, read_terragrunt_config,
// file(), terraform sources, hook scripts, and any path listed in a local:
// every path in the config counts.
// Path functions are resolved the way Terragrunt does, relative to the unit:
//   get_terragrunt_dir(), get_repo_root(), get_parent_terragrunt_dir(),
//   path.module, find_in_parent_folders("name").
// Included .hcl files are followed too (e.g. _envcommon/app.hcl and the modules it uses).

const ROOT = '\u0000R';       // marks a path that starts at the repo root
const FILE_EXT = /\.(hcl|tfvars|json|ya?ml|tf|tofu|tpl|sh|txt|pem|cfg|conf|ini|xml|toml)$/i;

const exists = (root: string, rel: string) => existsSync(rel === '.' ? root : join(root, rel));

// Nearest folder at or above `dir` holding `name`, as a repo-relative path.
const findUp = (root: string, dir: string, name: string): string | null => {
  for (const d of [dir, ...parentDirs(dir)]) {
    const candidate = d === '.' ? name : posix.join(d, name);
    if (exists(root, candidate)) return candidate;
  }
  return null;
};

// Replaces ${local.name} with the local's value when it is a plain string
// (after function expansion), so paths built from locals are found too.
const expandLocals = (text: string): string => {
  let out = text;
  for (let pass = 0; pass < 3; pass++) {
    const values = new Map<string, string>();
    for (const m of out.matchAll(/^\s*([A-Za-z_][\w-]*)\s*=\s*"([^"\n]*)"\s*$/gm)) values.set(m[1], m[2]);
    const next = out.replace(/\$\{\s*local\.([A-Za-z_][\w-]*)\s*\}/g, (whole, name: string) => values.get(name) ?? whole);
    if (next === out) break;
    out = next;
  }
  return out;
};

const expandFunctions = (text: string, root: string, unitDir: string): string => {
  const parentDir = (() => {
    for (const d of parentDirs(unitDir)) {
      if (exists(root, d === '.' ? 'root.hcl' : posix.join(d, 'root.hcl')) || exists(root, d === '.' ? 'terragrunt.hcl' : posix.join(d, 'terragrunt.hcl'))) return d;
    }
    return '.';
  })();
  const at = (d: string) => `${ROOT}/${d === '.' ? '' : d}`.replace(/\/+$/, '');
  return text
    // find_in_parent_folders searches from the unit's parent folder upwards.
    .replace(/find_in_parent_folders\(\s*(?:"([^"]*)")?\s*(?:,[^)]*)?\)/g, (_m, name: string | undefined) => {
      const start = unitDir === '.' ? '.' : (posix.dirname(unitDir) === '' ? '.' : posix.dirname(unitDir));
      const hit = findUp(root, start, name || 'terragrunt.hcl');
      return hit ? `"${ROOT}/${hit}"` : '""';
    })
    .replace(/\$\{\s*get_terragrunt_dir\(\s*\)\s*\}/g, at(unitDir))
    .replace(/\$\{\s*path\.module\s*\}/g, at(unitDir))
    .replace(/\$\{\s*get_parent_terragrunt_dir\(\s*\)\s*\}/g, at(parentDir))
    .replace(/\$\{\s*get_repo_root\(\s*\)\s*\}/g, ROOT);
};

// A quoted string from config as a repo-relative path, or null.
const toRepoPath = (raw: string, fromDir: string): string | null => {
  let v = raw.replace(/\?ref=.*$/, '');
  if (/^[a-z]+::|:\/\/|\$\{/.test(v) || !v) return null;   // remote sources, unresolved interpolation
  v = v.replace(/(?<!:)\/\/+/g, '/');                      // "modules//app" means the app folder
  if (v.startsWith(ROOT)) {
    const r = posix.normalize(v.slice(ROOT.length).replace(/^\/+/, '')) || '.';
    return r.startsWith('..') ? null : r.replace(/\/+$/, '') || '.';
  }
  if (v.startsWith('./') || v.startsWith('../') || (v.includes('/') && !v.startsWith('/')) || FILE_EXT.test(v)) {
    return resolveRel(fromDir, v);
  }
  return null;
};

export const terragruntRefs = (root: string, unitDir: string, text: string, seen = new Set<string>()): { files: Set<string>; dirs: Set<string> } => {
  const files = new Set<string>();
  const dirs = new Set<string>();
  const expanded = expandLocals(expandFunctions(text, root, unitDir));
  for (const m of expanded.matchAll(/"([^"\n]*)"/g)) {
    const path = toRepoPath(m[1], unitDir);
    if (!path || path === unitDir || !exists(root, path)) continue;
    if (lstatSync(path === '.' ? root : join(root, path)).isDirectory()) {
      // A parent folder (or the repo root) used to build other paths isn't a dependency.
      if (path === '.' || unitDir === path || unitDir.startsWith(`${path}/`)) continue;
      dirs.add(path);
    } else {
      if (path === posix.join(unitDir, 'terragrunt.hcl')) continue;
      files.add(path);
      // Included config is evaluated in the unit's context: follow it.
      if (path.endsWith('.hcl') && !seen.has(path)) {
        seen.add(path);
        const nested = terragruntRefs(root, unitDir, readFileSync(join(root, path), 'utf-8'), seen);
        nested.files.forEach(f => files.add(f));
        nested.dirs.forEach(d => dirs.add(d));
      }
    }
  }
  return { files, dirs };
};

// ---- dependency blocks -------------------------------------------------------------

export interface TgDependency { name: string; dir: string; mocks: string[] }

// The block body after `start` (index of its opening brace), by counting braces.
const blockBody = (text: string, start: number): string => {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start + 1, i);
  }
  return text.slice(start + 1);
};

// `dependency "vpc" { config_path = ...; mock_outputs = {...} }` blocks of a unit:
// where each points, and the literal mock values (to spot them in a plan).
export const terragruntDependencies = (root: string, unitDir: string, text: string): TgDependency[] => {
  const expanded = expandLocals(expandFunctions(text, root, unitDir));
  const out: TgDependency[] = [];
  for (const m of expanded.matchAll(/dependency\s+"([^"]+)"\s*\{/g)) {
    const body = blockBody(expanded, m.index! + m[0].length - 1);
    const cfg = /config_path\s*=\s*"([^"]+)"/.exec(body);
    const dir = cfg ? toRepoPath(cfg[1], unitDir) : null;
    if (!dir) continue;
    const mockStart = /mock_outputs\s*=\s*\{/.exec(body);
    const mocks = mockStart
      ? [...blockBody(body, mockStart.index + mockStart[0].length - 1).matchAll(/"([^"\n]{3,})"/g)].map(x => x[1])
      : [];
    out.push({ name: m[1], dir, mocks });
  }
  return out;
};

// Which dependencies a Terragrunt plan filled with mock outputs: Terragrunt's own
// warning, or a mock value showing up in the plan's input variables.
export const mockedDependencies = (unitDir: string, deps: TgDependency[], output: string, plan: Record<string, any> | undefined): string[] => {
  const hit = new Set<string>();
  for (const line of output.split('\n')) {
    const w = /Config\s+(\S+?)\/terragrunt\.hcl\s+is a dependency of .*mock outputs/i.exec(line);
    if (!w) continue;
    const dir = w[1].startsWith('/') ? null : resolveRel(unitDir, w[1]);
    const dep = deps.find(d => d.dir === dir) ?? deps.find(d => line.includes(`/${posix.basename(d.dir)}/terragrunt.hcl`));
    if (dep) hit.add(dep.dir);
  }
  const values = JSON.stringify(plan?.variables ?? {});
  for (const d of deps) if (d.mocks.some(v => values.includes(JSON.stringify(v)))) hit.add(d.dir);
  return [...hit];
};

// ---- tfv watch ---------------------------------------------------------------
// Extra files that should replan a project, for anything the config doesn't name:
//   # tfv:watch lambda/orders/**/*.py scripts/build.sh     (any .tf / .tofu / .hcl file)
//   locals { tfv_watch = ["${get_repo_root()}/lambda/**"] } (Terragrunt, with functions)
//   watch: [...]                                           (tfv.yaml, per project)
// Relative to the project folder; a leading "/" means the repo root. Globs allowed;
// a plain folder means everything inside it. Added to automatic detection.
const toWatchGlob = (root: string, projectDir: string, raw: string): string | null => {
  let v = raw.trim();
  if (!v) return null;
  let path: string;
  if (v.startsWith(ROOT)) path = v.slice(ROOT.length).replace(/^\/+/, '');
  else if (v.startsWith('/')) path = v.slice(1);
  else path = projectDir === '.' ? v : `${projectDir}/${v}`;
  path = posix.normalize(path).replace(/^\.\//, '');
  if (path.startsWith('..')) return null;
  const isGlob = /[*?[]/.test(path);
  if (!isGlob && existsSync(join(root, path)) && lstatSync(join(root, path)).isDirectory()) return `${path.replace(/\/+$/, '')}/**`;
  return path;
};

export const watchGlobs = (root: string, projectDir: string, files: { name: string; text: string }[], configured: string[] = []): string[] => {
  const out = new Set<string>();
  const add = (raw: string) => { const g = toWatchGlob(root, projectDir, raw); if (g) out.add(g); };
  configured.forEach(add);
  for (const f of files) {
    for (const m of f.text.matchAll(/(?:#|\/\/)\s*tfv:watch\s+([^\n]+)/g)) m[1].trim().split(/\s+/).forEach(add);
    if (f.name.endsWith('.hcl')) {
      const expanded = expandLocals(expandFunctions(f.text, root, projectDir));
      for (const m of expanded.matchAll(/tfv_watch\s*=\s*\[([\s\S]*?)\]/g)) {
        for (const q of m[1].matchAll(/"([^"\n]*)"/g)) if (!q[1].includes('${')) add(q[1]);
      }
    }
  }
  return [...out];
};

const projectFiles = (root: string, info: DirInfo) => [
  ...info.tfFiles.map(name => ({ name, text: readFileSync(join(root, info.dir, name), 'utf-8') })),
  ...(info.terragrunt ? [{ name: 'terragrunt.hcl', text: info.terragrunt }] : []),
];

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
  const tgRefs = new Map<string, ReturnType<typeof terragruntRefs>>();
  for (const info of dirs.values()) {
    const s = moduleSources(root, info);
    sources.set(info.dir, s);
    s.forEach(d => referenced.add(d));
    if (info.terragrunt) {
      // Folders a unit sources (terraform { source = ... }) are modules, not projects.
      const refs = terragruntRefs(root, info.dir, info.terragrunt);
      tgRefs.set(info.dir, refs);
      refs.dirs.forEach(d => { if (!dirs.get(d)?.terragrunt) referenced.add(d); });
    }
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
        const refs = tgRefs.get(info.dir)!;
        refs.files.forEach(f => deps.add(f));
        for (const d of refs.dirs) {
          deps.add(d);
          moduleClosure(d).forEach(m => deps.add(m)); // modules used by a referenced module
          for (const sub of sources.get(d) ?? []) deps.add(sub);
        }
      } else {
        // Files a plain project reads from outside its folder, e.g. file("${path.module}/../shared/policy.json").
        for (const f of info.tfFiles) {
          const refs = terragruntRefs(root, info.dir, readFileSync(join(root, info.dir, f), 'utf-8'));
          refs.files.forEach(x => { if (!(info.dir === '.' || x.startsWith(`${info.dir}/`))) deps.add(x); });
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
        watch: watchGlobs(root, info.dir, projectFiles(root, info)),
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
      watch: [...new Set([
        ...(base?.watch ?? []),
        ...watchGlobs(root, pc.dir, info ? projectFiles(root, info) : [], pc.watch ?? []),
      ])],
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
    if (p.watch.some(g => matchGlob(g, f))) return true;
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
