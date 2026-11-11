// Policy checks on plans: built-in rules on planned values, plus optional
// external scanners (Checkov, Conftest, tfsec...) run as server-defined commands.
// Mode "audit" reports findings; "enforce" also blocks apply.
import type { Principal } from './config.ts';
import { matchGlob } from './glob.ts';
import { exec } from './runner.ts';
import { BUILTIN_PACKS, BUILTIN_RULE_NAMES } from './security-rules.ts';

export type PolicyMode = 'off' | 'audit' | 'enforce';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
const MODE_RANK: Record<PolicyMode, number> = { off: 0, audit: 1, enforce: 2 };

export interface Condition {
  attribute: string;           // dot path into the resource's values, e.g. "versioning.0.enabled"
  equals?: unknown;
  in?: unknown[];
  matches?: string;            // regular expression on the value as text
  exists?: boolean;
}

export interface PolicyRule {
  name: string;
  description?: string;
  severity?: Severity;         // default high
  resource?: string;           // glob on the resource type, default "*"
  projects?: string[];         // globs on project name or dir, default all
  actions?: string[];          // create | update | replace | delete, default create/update/replace
  deny_if?: Condition;         // a finding when this is true
  require?: Condition;         // a finding when this is false
  message?: string;
}

export interface PolicyCommand {
  name: string;
  run: string[];               // argv; "{plan_json}" is replaced with the plan JSON file
  severity?: Severity;
  projects?: string[];
}

export interface PolicyConfig {
  mode?: PolicyMode;
  override?: Principal[];      // may apply despite enforced findings, with --override
  rules?: PolicyRule[];
  commands?: PolicyCommand[];
  builtin?: string[];          // ready-made rule packs, e.g. [security]
  disable?: string[];          // built-in rules to skip, by name
}

export interface Finding {
  rule: string;
  severity: Severity;
  address: string;             // resource, or "(scanner)" for command output
  message: string;
}

export interface PolicyResult {
  mode: PolicyMode;
  findings: Finding[];
}

export const validatePolicies = (cfg: unknown, where: string): PolicyConfig | undefined => {
  if (cfg === undefined || cfg === null) return undefined;
  const c = cfg as PolicyConfig;
  if (c.mode && !(c.mode in MODE_RANK)) throw new Error(`${where}.mode must be off, audit or enforce`);
  for (const [i, r] of (c.rules ?? []).entries()) {
    if (!r?.name) throw new Error(`${where}.rules[${i}].name is required`);
    if (r.severity && !SEVERITIES.includes(r.severity)) throw new Error(`${where}.rules[${i}].severity must be one of ${SEVERITIES.join(', ')}`);
    for (const cond of [r.deny_if, r.require]) {
      if (cond && typeof cond.attribute !== 'string') throw new Error(`${where}.rules[${i}]: conditions need an "attribute"`);
      if (cond?.matches) new RegExp(cond.matches);
    }
  }
  for (const p of c.builtin ?? []) {
    if (!BUILTIN_PACKS.includes(p)) throw new Error(`${where}.builtin: unknown pack "${p}" (${BUILTIN_PACKS.join(', ')})`);
  }
  for (const n of c.disable ?? []) {
    if (!BUILTIN_RULE_NAMES.includes(n)) throw new Error(`${where}.disable: unknown built-in rule "${n}"`);
  }
  for (const [i, k] of (c.commands ?? []).entries()) {
    if (!k?.name || !Array.isArray(k.run) || !k.run.length) throw new Error(`${where}.commands[${i}] needs a name and a "run" argument list`);
  }
  return c;
};

// The stricter of two modes (repo settings can only tighten).
export const stricter = (a: PolicyMode | undefined, b: PolicyMode | undefined): PolicyMode =>
  (MODE_RANK[a ?? 'off'] >= MODE_RANK[b ?? 'off'] ? a : b) ?? 'off';

// Reads "a.b.0.c" out of nested objects and lists.
export const getPath = (obj: unknown, path: string): { found: boolean; value: unknown } => {
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object' || !(part in cur)) return { found: false, value: undefined };
    cur = cur[part];
  }
  return { found: true, value: cur };
};

const holds = (cond: Condition, values: unknown): boolean => {
  const { found, value } = getPath(values, cond.attribute);
  if (cond.exists !== undefined) return cond.exists === (found && value !== null);
  if (!found) return false;
  if ('equals' in cond) return JSON.stringify(value) === JSON.stringify(cond.equals);
  if (cond.in) return cond.in.some(v => JSON.stringify(v) === JSON.stringify(value));
  if (cond.matches) return new RegExp(cond.matches).test(typeof value === 'string' ? value : JSON.stringify(value));
  return found && value !== null && value !== false;
};

const actionOf = (actions: string[]): string => {
  const a = actions.join(',');
  if (a === 'delete,create' || a === 'create,delete') return 'replace';
  return a;
};

const projectMatches = (globs: string[] | undefined, project: { name: string; dir: string }) =>
  !globs?.length || globs.some(g => matchGlob(g, project.name) || matchGlob(g, project.dir));

// Built-in rules against `terraform show -json` output.
export const evaluateRules = (plan: Record<string, any>, rules: PolicyRule[], project: { name: string; dir: string }): Finding[] => {
  const findings: Finding[] = [];
  for (const rule of rules) {
    if (!projectMatches(rule.projects, project)) continue;
    const actions = rule.actions ?? ['create', 'update', 'replace'];
    for (const rc of plan.resource_changes ?? []) {
      if (rc.mode === 'data') continue;
      const action = actionOf(rc.change?.actions ?? []);
      if (!actions.includes(action)) continue;
      if (!matchGlob(rule.resource ?? '*', rc.type)) continue;
      // Deletes are judged on what exists now; everything else on what will exist.
      const values = action === 'delete' ? rc.change?.before : rc.change?.after;
      const unknown = rc.change?.after_unknown ?? {};
      let failed: boolean;
      if (rule.deny_if) {
        if (getPath(unknown, rule.deny_if.attribute).value === true) continue; // decided at apply time
        failed = holds(rule.deny_if, values);
      } else if (rule.require) {
        if (getPath(unknown, rule.require.attribute).value === true) continue;
        failed = !holds(rule.require, values);
      } else {
        failed = true; // the change itself is not allowed
      }
      if (failed) {
        findings.push({
          rule: rule.name,
          severity: rule.severity ?? 'high',
          address: rc.address,
          message: rule.message ?? rule.description ?? rule.name,
        });
      }
    }
  }
  return findings;
};

// External scanners: a non-zero exit is a finding with the tail of their output.
export const runCommands = async (
  commands: PolicyCommand[], planJsonPath: string, cwd: string, env: NodeJS.ProcessEnv, project: { name: string; dir: string },
): Promise<Finding[]> => {
  const findings: Finding[] = [];
  for (const c of commands) {
    if (!projectMatches(c.projects, project)) continue;
    const [bin, ...args] = c.run.map(a => a.replaceAll('{plan_json}', planJsonPath));
    const r = await exec(bin, args, cwd, env, { timeoutMs: 600_000 });
    if (r.code !== 0) {
      const tail = r.output.trim().split('\n').slice(-12).join('\n');
      findings.push({ rule: c.name, severity: c.severity ?? 'high', address: '(scanner)', message: tail || `${c.name} exited with code ${r.code}` });
    }
  }
  return findings;
};

export const SEVERITY_ICON: Record<Severity, string> = { critical: '🔴', high: '🔴', medium: '🟠', low: '🟡' };
