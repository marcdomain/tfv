// Settings for the safety features: approvals across rebases, out-of-date branches,
// plan integrity, the leaked-secret scan, risk scores, change freezes, protected
// resources, emergency access and the weekly summary. Server-wide in repos.yaml,
// with per-repo values that can only make things stricter.
import { parseCron, validTimeZone } from './cron.ts';
import type { ApprovalRule, Principal } from './config.ts';

export type StaleBaseMode = 'off' | 'warn' | 'block';
export const STALE_BASE_MODES: StaleBaseMode[] = ['off', 'warn', 'block'];
export type SecretScanMode = 'off' | 'redact' | 'fail';
export const SECRET_SCAN_MODES: SecretScanMode[] = ['off', 'redact', 'fail'];
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

export interface SecretPattern { name: string; regex: string }
export interface SecretScanConfig { mode?: SecretScanMode; patterns?: SecretPattern[] }

export interface RiskConfig {
  production?: string[];                                   // globs on project name or dir
  extra_approval?: Partial<Record<RiskLevel, ApprovalRule>>; // extra approval at this level and above
  stateful_types?: string[];                               // more resource types (globs) that hold data, added to the built-in list
  size_limits?: { medium?: number; high?: number };        // changed resources that make a plan medium / high (default 25 / 100)
}

export const DEFAULT_SIZE_LIMITS = { medium: 25, high: 100 };

export interface FreezeWindow {
  name: string;
  projects?: string[];       // globs; default every project
  schedule?: string;         // cron: when the freeze starts
  hours?: number;            // how long it lasts after each start
  from?: string;             // or a date range, YYYY-MM-DD (inclusive)
  to?: string;
  timezone?: string;         // IANA name, default UTC
  override?: Principal[];    // who may apply anyway with --override (default: nobody)
}
export type FreezeConfig = FreezeWindow[];

export interface ProtectedRule {
  projects?: string[];       // globs; default every project
  resources: string[];       // address globs
  override?: Principal[];    // who may destroy/replace them anyway with --override (default: nobody)
}
export type ProtectedConfig = ProtectedRule[];

export interface BreakGlassConfig {
  grantors: string[];        // dashboard identities: "admin", "user:<name or email>", "group:<oidc group>"
  max_hours?: number;        // default 4
  notify?: string[];         // channels told about grants, use, revokes and expiry
}

export interface SummaryConfig {
  schedule: string;          // cron
  timezone?: string;
  notify: string[];
  days?: number;             // the period covered, default 7
}

const MODE_RANK: Record<string, number> = { off: 0, warn: 1, redact: 1, block: 2, fail: 2 };
// The stricter of two values (repo settings can only tighten).
export const stricterMode = <T extends string>(a: T | undefined, b: T | undefined, fallback: T): T => {
  const x = a ?? fallback;
  if (b === undefined) return x;
  return (MODE_RANK[b] ?? 0) > (MODE_RANK[x] ?? 0) ? b : x;
};

const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const strings = (v: unknown, where: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${where} must be a list of strings`);
  return v as string[];
};

export const validateApproval = (a: unknown, where: string): ApprovalRule => {
  const r = a as ApprovalRule;
  if (!r || typeof r.from !== 'string' || !(r.count >= 1)) throw new Error(`${where} needs "from" and "count" >= 1`);
  return r;
};

export const validateSecretScan = (v: unknown, where: string): SecretScanConfig | undefined => {
  if (v === undefined || v === null) return undefined;
  // Short form: `secret_scan: fail`
  const c: SecretScanConfig = typeof v === 'string' ? { mode: v as SecretScanMode } : v as SecretScanConfig;
  if (c.mode && !SECRET_SCAN_MODES.includes(c.mode)) throw new Error(`${where}.mode must be ${SECRET_SCAN_MODES.join(', ')}`);
  for (const [i, p] of (c.patterns ?? []).entries()) {
    if (!p?.name || typeof p.regex !== 'string') throw new Error(`${where}.patterns[${i}] needs a name and a regex`);
    try { new RegExp(p.regex); } catch (err) { throw new Error(`${where}.patterns[${i}].regex: ${(err as Error).message}`); }
  }
  return c;
};

export const validateRisk = (v: unknown, where: string): RiskConfig | undefined => {
  if (v === undefined || v === null) return undefined;
  const c = v as RiskConfig;
  strings(c.production, `${where}.production`);
  strings(c.stateful_types, `${where}.stateful_types`);
  if (c.size_limits !== undefined) {
    const s = c.size_limits;
    if (typeof s !== 'object' || s === null) throw new Error(`${where}.size_limits must be { medium: <n>, high: <n> }`);
    for (const k of Object.keys(s)) if (k !== 'medium' && k !== 'high') throw new Error(`${where}.size_limits: unknown key "${k}" (medium, high)`);
    for (const k of ['medium', 'high'] as const) {
      if (s[k] !== undefined && !(Number.isInteger(s[k]) && s[k]! >= 1)) throw new Error(`${where}.size_limits.${k} must be a whole number of resources, 1 or more`);
    }
    if ((s.medium ?? DEFAULT_SIZE_LIMITS.medium) >= (s.high ?? DEFAULT_SIZE_LIMITS.high)) throw new Error(`${where}.size_limits.medium must be lower than high`);
  }
  for (const [level, rule] of Object.entries(c.extra_approval ?? {})) {
    if (!RISK_LEVELS.includes(level as RiskLevel)) throw new Error(`${where}.extra_approval: unknown level "${level}" (${RISK_LEVELS.join(', ')})`);
    validateApproval(rule, `${where}.extra_approval.${level}`);
  }
  return c;
};

export const validateFreezes = (v: unknown, where: string): FreezeConfig | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error(`${where} must be a list of windows, e.g. - { name: weekend, schedule: "0 15 * * 5", hours: 63 }`);
  const c = v as FreezeConfig;
  for (const [i, w] of c.entries()) {
    const at = `${where}[${i}]`;
    strings(w?.override, `${at}.override`);
    if (!w?.name) throw new Error(`${at}.name is required`);
    strings(w.projects, `${at}.projects`);
    if (w.timezone && !validTimeZone(w.timezone)) throw new Error(`${at}.timezone "${w.timezone}" is not a known time zone`);
    if (w.schedule) {
      parseCron(w.schedule);
      if (!(typeof w.hours === 'number' && w.hours > 0 && w.hours <= 24 * 14)) throw new Error(`${at}.hours must be a number of hours (1 to 336) with "schedule"`);
      if (w.from || w.to) throw new Error(`${at}: use either schedule + hours, or from + to`);
    } else {
      if (!isDate(w.from) || !isDate(w.to)) throw new Error(`${at} needs schedule + hours, or from + to dates (YYYY-MM-DD)`);
      if (w.from! > w.to!) throw new Error(`${at}.from must not be after to`);
    }
  }
  return c;
};

export const validateProtected = (v: unknown, where: string): ProtectedConfig | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error(`${where} must be a list, e.g. - { resources: ["aws_db_instance.*"], override: [team:sre] }`);
  const c = v as ProtectedConfig;
  for (const [i, r] of c.entries()) {
    strings(r?.projects, `${where}[${i}].projects`);
    strings(r?.override, `${where}[${i}].override`);
    if (!strings(r?.resources, `${where}[${i}].resources`).length) throw new Error(`${where}[${i}].resources needs at least one address glob`);
  }
  return c;
};

export const validateBreakGlass = (v: unknown, where: string, channels: Record<string, unknown>): BreakGlassConfig | undefined => {
  if (v === undefined || v === null) return undefined;
  const c = v as BreakGlassConfig;
  if (!strings(c.grantors, `${where}.grantors`).length) throw new Error(`${where}.grantors needs at least one grantor`);
  for (const g of c.grantors) {
    if (g !== 'admin' && !/^(user|group):.+/.test(g)) throw new Error(`${where}.grantors: "${g}" must be admin, user:<name> or group:<group>`);
  }
  if (c.max_hours !== undefined && !(c.max_hours > 0 && c.max_hours <= 72)) throw new Error(`${where}.max_hours must be between 1 and 72`);
  for (const n of strings(c.notify, `${where}.notify`)) if (!channels[n]) throw new Error(`${where}.notify: no channel named "${n}"`);
  return c;
};

export const validateSummary = (v: unknown, where: string, channels: Record<string, unknown>): SummaryConfig | undefined => {
  if (v === undefined || v === null) return undefined;
  const c = v as SummaryConfig;
  if (typeof c.schedule !== 'string') throw new Error(`${where}.schedule is required (cron)`);
  parseCron(c.schedule);
  if (c.timezone && !validTimeZone(c.timezone)) throw new Error(`${where}.timezone "${c.timezone}" is not a known time zone`);
  if (!strings(c.notify, `${where}.notify`).length) throw new Error(`${where}.notify needs at least one channel`);
  for (const n of c.notify) if (!channels[n]) throw new Error(`${where}.notify: no channel named "${n}"`);
  if (c.days !== undefined && !(c.days >= 1 && c.days <= 90)) throw new Error(`${where}.days must be between 1 and 90`);
  return c;
};

export const validateStaleBase = (v: unknown, where: string): StaleBaseMode | undefined => {
  if (v === undefined) return undefined;
  if (!STALE_BASE_MODES.includes(v as StaleBaseMode)) throw new Error(`${where} must be ${STALE_BASE_MODES.join(', ')}`);
  return v as StaleBaseMode;
};

export const validateBool = (v: unknown, where: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${where} must be true or false`);
  return v;
};
