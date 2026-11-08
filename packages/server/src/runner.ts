// Runs plan / apply for one project with the exact tool versions it pins.
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Project } from './discovery.ts';
import type { Provider } from './tfv.ts';
import { tfv } from './tfv.ts';
import { redact } from './log.ts';
import { summarizePlan, type PlanSummary } from './render.ts';

export interface Tool { provider: Provider; version: string; binary: string }
export interface ToolSet { tool: Tool; terragrunt?: Tool }

export interface ToolResolver {
  resolve(root: string, project: Project): Promise<ToolSet>;
}

const parents = (root: string, dir: string): string[] => {
  const out: string[] = [];
  let d = dir === '.' ? root : join(root, dir);
  while (true) {
    out.push(d);
    if (d === root) break;
    const up = dirname(d);
    if (up === d || !up.startsWith(root)) break;
    d = up;
  }
  return out;
};

// Version pinned for `provider`: the project dir (all sources), then parent
// dirs up to the repo root (version files and terragrunt constraints only).
export const findPinnedUp = (root: string, dir: string, provider: Provider): string | null => {
  const core = tfv();
  const [own, ...ups] = parents(root, dir);
  const pinned = core.findPinnedVersion(own, provider);
  if (pinned) return pinned.version;
  for (const d of ups) {
    const p = core.findPinnedVersion(d, provider, { strict: true })
      ?? (provider !== 'terragrunt' ? core.findHclConstraint(d, 'terraform_version_constraint') : null);
    if (p) return p.version;
  }
  return null;
};

export const tfvResolver = (defaultVersion: string): ToolResolver => ({
  async resolve(root, project) {
    const core = tfv();
    const get = async (provider: Provider, configured?: string): Promise<Tool> => {
      const wanted = configured ?? findPinnedUp(root, project.dir, provider) ?? defaultVersion;
      const exact = await core.resolveExactVersion(provider, wanted === 'latest' ? '>= 0' : wanted);
      const r = await core.installVersion(provider, exact);
      return { provider, version: r.version, binary: r.binary };
    };
    const tool = await get(project.tool, project.version);
    const terragrunt = project.engine === 'terragrunt' ? await get('terragrunt', project.terragruntVersion) : undefined;
    return { tool, terragrunt };
  },
});

export const engineLabel = (t: ToolSet) =>
  t.terragrunt ? `terragrunt ${t.terragrunt.version} + ${t.tool.provider} ${t.tool.version}` : `${t.tool.provider} ${t.tool.version}`;

// ---- process execution ----------------------------------------------------

const MAX_OUTPUT = 4 * 1024 * 1024;

interface ExecResult { code: number; output: string; stdout: string }

export const exec = (
  binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  opts: { timeoutMs: number; captureStdout?: boolean; onOutput?: (chunk: string) => void },
): Promise<ExecResult> => new Promise((resolve) => {
  const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let stdout = '';
  const add = (chunk: Buffer, isStdout: boolean) => {
    const text = chunk.toString('utf-8');
    if (isStdout && opts.captureStdout) { stdout += text; return; }
    output += text;
    if (output.length > MAX_OUTPUT) output = output.slice(output.length - MAX_OUTPUT);
    opts.onOutput?.(redact(text));
  };
  child.stdout.on('data', c => add(c, true));
  child.stderr.on('data', c => add(c, false));
  const timer = setTimeout(() => {
    output += `\n[tfv] timed out after ${Math.round(opts.timeoutMs / 1000)}s; stopping\n`;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
  }, opts.timeoutMs);
  child.on('error', err => { clearTimeout(timer); resolve({ code: 127, output: `${output}\n${err.message}`, stdout }); });
  child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, output: redact(output), stdout }); });
});

// Env for terraform/terragrunt: the server's env minus its own settings and
// secrets (anything TFV_*), plus automation flags and PR context.
export const toolEnv = (base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('TFV_')) env[k] = v;
  return {
    ...env,
    TF_IN_AUTOMATION: '1',
    TF_INPUT: '0',
    CHECKPOINT_DISABLE: '1',
    TG_NON_INTERACTIVE: 'true',
    TERRAGRUNT_NON_INTERACTIVE: 'true',
    TG_NO_COLOR: 'true',
    TERRAGRUNT_NO_COLOR: 'true',
    ...extra,
  };
};

export interface RunContext {
  root: string;               // checkout dir
  project: Project;
  tools: ToolSet;
  planPath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput?: (chunk: string) => void;
}

export interface PlanResult {
  ok: boolean;
  output: string;
  summary: PlanSummary | null;
  hasChanges: boolean;
  plan?: Record<string, any>;  // full `show -json` output
  planJsonPath?: string;       // the same, written next to the plan file
}

const steps = (ctx: RunContext) => {
  const { tools, project } = ctx;
  const cwd = project.dir === '.' ? ctx.root : join(ctx.root, project.dir);
  const env = tools.terragrunt
    ? { ...ctx.env, TG_TF_PATH: tools.tool.binary, TERRAGRUNT_TFPATH: tools.tool.binary }
    : ctx.env;
  const bin = tools.terragrunt?.binary ?? tools.tool.binary;
  // Server paths mean nothing to PR readers: show the plan as "tfplan", the checkout as ".".
  const tidy = (text: string) => text.split(ctx.planPath).join('tfplan').split(ctx.root).join('.');
  const run = async (args: string[], log: string[], captureStdout = false) => {
    log.push(tidy(`$ ${tools.terragrunt ? 'terragrunt' : tools.tool.provider === 'opentofu' ? 'tofu' : 'terraform'} ${args.join(' ')}`));
    const r = await exec(bin, args, cwd, env, { timeoutMs: ctx.timeoutMs, captureStdout, onOutput: ctx.onOutput });
    if (r.output.trim()) log.push(tidy(r.output.trimEnd()));
    return r;
  };
  const prepare = async (log: string[]) => {
    // Terragrunt runs init itself.
    if (!tools.terragrunt) {
      const init = await run(['init', '-input=false', '-no-color'], log);
      if (init.code !== 0) return false;
    }
    if (project.workspace !== 'default') {
      const ws = await run(['workspace', 'select', '-or-create=true', project.workspace], log);
      if (ws.code !== 0) return false;
    }
    return true;
  };
  return { run, prepare };
};

export const plan = async (ctx: RunContext, opts: { destroy?: boolean; targets?: string[]; extraArgs?: string[]; refreshOnly?: boolean; noLock?: boolean } = {}): Promise<PlanResult> => {
  const log: string[] = [];
  const { run, prepare } = steps(ctx);
  mkdirSync(dirname(ctx.planPath), { recursive: true });
  if (existsSync(ctx.planPath)) rmSync(ctx.planPath);

  if (!(await prepare(log))) return { ok: false, output: log.join('\n'), summary: null, hasChanges: false };

  const args = ['plan', '-input=false', '-no-color', '-detailed-exitcode', `-out=${ctx.planPath}`];
  if (opts.destroy) args.push('-destroy');
  for (const t of opts.targets ?? []) args.push(`-target=${t}`);
  // Drift checks only read: -refresh-only finds changes made outside Terraform,
  // and -lock=false keeps them from blocking a PR's apply.
  if (opts.refreshOnly) args.push('-refresh-only');
  if (opts.noLock) args.push('-lock=false');
  args.push(...(opts.extraArgs ?? []));
  const p = await run(args, log);
  // -detailed-exitcode: 0 no changes, 2 changes, anything else failed.
  if (p.code !== 0 && p.code !== 2) return { ok: false, output: log.join('\n'), summary: null, hasChanges: false };

  const show = await run(['show', '-json', ctx.planPath], [], true);
  let summary: PlanSummary | null = null;
  let parsed: Record<string, any> | undefined;
  let planJsonPath: string | undefined;
  try {
    // Terragrunt may print log lines before the JSON.
    const json = show.stdout.slice(show.stdout.indexOf('{'));
    parsed = JSON.parse(json);
    summary = summarizePlan(parsed!);
    planJsonPath = `${ctx.planPath}.json`;
    writeFileSync(planJsonPath, json);
  } catch {
    log.push('[tfv] could not read the plan as JSON; showing raw output only');
  }
  const hasChanges = summary ? !summary.noChanges : p.code === 2;
  return { ok: true, output: log.join('\n'), summary, hasChanges, plan: parsed, planJsonPath };
};

export const apply = async (ctx: RunContext): Promise<{ ok: boolean; output: string }> => {
  const log: string[] = [];
  const { run, prepare } = steps(ctx);
  if (!existsSync(ctx.planPath)) return { ok: false, output: 'The saved plan is gone; run plan again.' };
  if (!(await prepare(log))) return { ok: false, output: log.join('\n') };
  const r = await run(['apply', '-input=false', '-no-color', ctx.planPath], log);
  return { ok: r.code === 0, output: log.join('\n') };
};
