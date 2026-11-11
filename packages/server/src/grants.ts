// Emergency access ("break glass"): a grantor gives someone a permission for a few
// hours, with a reason. It is removed automatically when time is up, and every grant,
// first use, revoke and expiry goes to the audit log and the configured channels.
import type { BreakGlassConfig } from './safety-config.ts';
import type { ChannelConfig, Person } from './config.ts';
import { ACTIONS } from './config.ts';
import type { Grant, Store } from './store.ts';
import { notifyText } from './notify.ts';
import { log } from './log.ts';

export const BYPASS_KINDS = ['approvals', 'freeze', 'protected', 'policy'] as const;

export interface Who { sub: string; name: string; role: string; email?: string; groups?: string[] }

// May this dashboard user grant emergency access?
export const isGrantor = (who: Who, cfg: BreakGlassConfig | undefined): boolean => {
  if (!cfg) return false;
  const ids = [who.sub, who.name, who.email].filter(Boolean).map(s => s!.toLowerCase());
  return cfg.grantors.some(g => {
    if (g === 'admin') return who.role === 'admin';
    if (g.startsWith('user:')) return ids.includes(g.slice(5).toLowerCase());
    if (g.startsWith('group:')) return (who.groups ?? []).includes(g.slice(6));
    return false;
  });
};

export interface GrantRequest {
  user: string; repo: string; projects: string[]; actions: string[]; bypass: string[]; hours: number; reason: string;
}

// Checks a grant request from the dashboard; returns it cleaned up, or an error.
export const parseGrantRequest = (body: Record<string, unknown>, cfg: BreakGlassConfig): GrantRequest | { error: string } => {
  const user = String(body.user ?? '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(user)) return { error: 'Enter the source-control username the access is for.' };
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(x => String(x).trim()).filter(Boolean);
  const actions = list(body.actions);
  if (!actions.length) return { error: 'Choose at least one permission (for example apply).' };
  const unknownAction = actions.find(a => !(ACTIONS as readonly string[]).includes(a));
  if (unknownAction) return { error: `Unknown permission "${unknownAction}".` };
  const bypass = list(body.bypass);
  const unknownBypass = bypass.find(b => !(BYPASS_KINDS as readonly string[]).includes(b));
  if (unknownBypass) return { error: `Unknown check to skip "${unknownBypass}" (${BYPASS_KINDS.join(', ')}).` };
  const max = cfg.max_hours ?? 4;
  const hours = Number(body.hours);
  if (!(hours > 0 && hours <= max)) return { error: `Duration must be more than 0 and at most ${max} hours.` };
  const reason = String(body.reason ?? '').trim();
  if (reason.length < 10) return { error: 'Give a reason (at least 10 characters): it goes to the audit log.' };
  const repo = String(body.repo ?? '').trim() || '*';
  return { user, repo, projects: list(body.projects), actions, bypass, hours, reason: reason.slice(0, 500) };
};

export const grantText = (g: Grant) =>
  `${g.actions.join(', ')} on ${g.projects.length ? g.projects.map(p => `\`${p}\``).join(', ') : 'every project'} in ${g.repo === '*' ? 'every repo' : g.repo}`
  + (g.bypass.length ? `, skipping ${g.bypass.join(', ')}` : '');

export interface NotifyDeps {
  store: Store;
  cfg?: BreakGlassConfig;
  channels: Record<string, ChannelConfig>;
  people: Person[];
  env: NodeJS.ProcessEnv;
  publicUrl?: string;
  fetchImpl?: typeof fetch;
}

export const announce = (d: NotifyDeps, title: string, g: Grant, event: string, extra: string[] = []) => {
  const names = d.cfg?.notify ?? [];
  if (!names.length) return Promise.resolve([]);
  return notifyText(names, d.channels, {
    title, event, data: { grant: g }, url: d.publicUrl ? `${d.publicUrl}/#access` : undefined,
    lines: [`**${g.user}**: ${grantText(g)}`, `Reason: ${g.reason}`, `Granted by ${g.grantedBy}, expires ${g.expiresAt}`, ...extra],
  }, { people: d.people, env: d.env, fetchImpl: d.fetchImpl });
};

// Reports grants as they expire (once a minute).
export class GrantWatcher {
  private timer: NodeJS.Timeout | null = null;
  private d: NotifyDeps;
  constructor(d: NotifyDeps) { this.d = d; }
  start() { this.timer = setInterval(() => void this.check(), 60_000); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); }
  async check(now = new Date()) {
    for (const g of this.d.store.takeExpiredGrants(now.toISOString())) {
      this.d.store.audit({ repo: g.repo, pr: 0, user: g.user, action: 'break_glass_expired', project: g.projects.join(',') || '*', allowed: true, reason: `emergency access #${g.id} expired (${grantText(g)})` });
      await announce(this.d, `⌛ Emergency access #${g.id} for ${g.user} expired`, g, 'teriac.break_glass.expired').catch(err => log.warn('grant expiry notice failed', { err }));
    }
  }
}
