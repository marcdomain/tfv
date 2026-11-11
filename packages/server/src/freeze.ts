// Change freezes (no applies in these windows) and protected resources (never destroyed
// or replaced). Both block applies only; plans still run. People in the matching
// `override` list can apply anyway with --override, which is audited.
import type { FreezeConfig, FreezeWindow, ProtectedConfig } from './safety-config.ts';
import type { PlanSummary } from './render.ts';
import { parseCron, cronMatches } from './cron.ts';
import { matchGlob } from './glob.ts';
import { addressParts } from './blame.ts';

const projectMatches = (globs: string[] | undefined, project: { name: string; dir: string }) =>
  !globs?.length || globs.some(g => matchGlob(g, project.name) || matchGlob(g, project.dir));

// YYYY-MM-DD of `date` in `timeZone`.
const dayIn = (date: Date, timeZone: string) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return p; // en-CA formats as YYYY-MM-DD
};

const fmt = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);

const startCache = new Map<string, Date | null>();

// When the current run of a scheduled window started, if it's on now.
const scheduledStart = (w: FreezeWindow, now: Date): Date | null => {
  const tz = w.timezone ?? 'UTC';
  const minute = Math.floor(now.getTime() / 60_000);
  const key = `${w.schedule}|${w.hours}|${tz}|${minute}`;
  if (startCache.has(key)) return startCache.get(key)!;
  const cron = parseCron(w.schedule!);
  let found: Date | null = null;
  for (let i = 0; i < w.hours! * 60; i++) {
    const t = new Date((minute - i) * 60_000);
    if (cronMatches(cron, t, tz)) { found = t; break; }
  }
  if (startCache.size > 500) startCache.clear();
  startCache.set(key, found);
  return found;
};

export interface ActiveFreeze { name: string; until: string; override: string[] }

// When a window that is on now ends (in its time zone), or null when it's off.
export const windowUntil = (w: FreezeWindow, now = new Date()): string | null => {
  const tz = w.timezone ?? 'UTC';
  if (w.schedule) {
    const start = scheduledStart(w, now);
    return start ? `${fmt(new Date(start.getTime() + w.hours! * 3_600_000), tz)} ${tz}` : null;
  }
  if (w.from && w.to) {
    const today = dayIn(now, tz);
    return today >= w.from && today <= w.to ? `end of ${w.to} ${tz}` : null;
  }
  return null;
};

// Freezes on now for this project, with when each ends (in the window's time zone).
export const activeFreezes = (cfg: FreezeConfig | undefined, project: { name: string; dir: string }, now = new Date()): ActiveFreeze[] => {
  const out: ActiveFreeze[] = [];
  for (const w of cfg ?? []) {
    if (!projectMatches(w.projects, project)) continue;
    const until = windowUntil(w, now);
    if (until) out.push({ name: w.name, until, override: w.override ?? [] });
  }
  return out;
};

// The resource part of an address, without module prefixes and [index] keys.
const resourcePart = (address: string) => {
  const parts = addressParts(address);
  let i = 0;
  while (parts[i] === 'module') i += 2;
  return parts.slice(i).join('.');
};

export interface ProtectedHit { address: string; override: string[] }

// Protected resources this plan would destroy or replace, each with who may override it.
// A resource matched by several entries needs an override from each of them.
export const protectedHits = (cfg: ProtectedConfig | undefined, project: { name: string; dir: string }, summary: PlanSummary | null): ProtectedHit[] => {
  if (!summary || !cfg?.length) return [];
  const rules = cfg.filter(r => projectMatches(r.projects, project));
  const out: ProtectedHit[] = [];
  for (const c of summary.changes) {
    if (c.action !== 'delete' && c.action !== 'replace') continue;
    const names = [c.address, c.address.replace(/\[[^\]]*\]/g, ''), resourcePart(c.address)];
    for (const r of rules) {
      if (r.resources.some(g => names.some(n => matchGlob(g, n)))) out.push({ address: c.address, override: r.override ?? [] });
    }
  }
  return out;
};

