// The weekly summary: runs, failures, delivery speed, open drift, old locks, the
// slowest projects and the most active people, sent to chat on a schedule.
import type { SummaryConfig } from './safety-config.ts';
import type { ChannelConfig, Person } from './config.ts';
import type { Store } from './store.ts';
import { parseCron, cronMatches } from './cron.ts';
import { notifyText, type TextMessage } from './notify.ts';
import { log } from './log.ts';

const OLD_LOCK_DAYS = 3;

const dur = (secs: number | null) => {
  if (secs === null) return '—';
  if (secs < 90) return `${Math.round(secs)}s`;
  if (secs < 5400) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
};
const hrs = (h: number | null) => (h === null ? '—' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)} days`);
const ago = (iso: string, now: Date) => `${Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000)} days`;

export const buildSummary = (store: Store, days: number, now = new Date(), publicUrl?: string): TextMessage => {
  const from = new Date(now.getTime() - days * 86_400_000).toISOString();
  const to = now.toISOString();
  const st = store.stats(from, to);
  const t = st.totals as Record<string, number>;
  const d = st.delivery;
  const lines: string[] = [];

  lines.push(`**Runs:** ${t.plans} plans · ${t.applies} applies · ${t.failed} failed · ${t.prs} PRs · ${t.users} people`);
  lines.push(`**Delivery:** PR to applied ${hrs(d.leadTime.p50)} (median) · failed applies ${d.failureRate === null ? '—' : `${d.failureRate}%`} · fixed in ${hrs(d.recovery.p50)} (median)`);

  // The newest drift result of each schedule and project.
  const latest = new Map<string, Record<string, any>>();
  for (const r of store.recentDrift(500)) {
    const key = `${r.schedule_key}::${r.project}`;
    if (!latest.has(key)) latest.set(key, r);
  }
  const drifted = [...latest.values()].filter(r => r.status === 'drift');
  const errored = [...latest.values()].filter(r => r.status === 'error');
  lines.push(drifted.length || errored.length
    ? `**Drift:** ${drifted.length} project${drifted.length === 1 ? '' : 's'} drifted${drifted.length ? ` (${drifted.slice(0, 5).map(r => `\`${r.project}\``).join(', ')}${drifted.length > 5 ? ', …' : ''})` : ''}${errored.length ? ` · ${errored.length} check${errored.length === 1 ? '' : 's'} failing` : ''}`
    : '**Drift:** none open');

  const old = store.allLocks().filter(l => now.getTime() - Date.parse(l.createdAt) > OLD_LOCK_DAYS * 86_400_000);
  if (old.length) lines.push(`**Old locks:** ${old.slice(0, 5).map(l => `\`${l.project}\` by #${l.pr} (${ago(l.createdAt, now)})`).join(', ')}${old.length > 5 ? `, and ${old.length - 5} more` : ''}`);

  const slow = store.slowestProjects(from, to, 3);
  if (slow.length) lines.push(`**Slowest:** ${slow.map(s => `\`${s.project}\` ${dur(s.avgSeconds)}`).join(' · ')}`);

  const people = (st.people as { user: string; runs: number }[]).slice(0, 3);
  if (people.length) lines.push(`**Most active:** ${people.map(p => `${p.user} (${p.runs})`).join(' · ')}`);

  const findings = (st.policy.bySeverity as { n: number }[]).reduce((a, b) => a + b.n, 0);
  const denied = (st.decisions.denied as { n: number }[]).reduce((a, b) => a + b.n, 0);
  if (findings || denied) lines.push(`**Guardrails:** ${findings} policy finding${findings === 1 ? '' : 's'} · ${denied} action${denied === 1 ? '' : 's'} refused`);

  const grants = store.listGrants(200).filter(g => g.createdAt >= from);
  if (grants.length) lines.push(`**Emergency access:** ${grants.length} grant${grants.length === 1 ? '' : 's'} (${grants.slice(0, 3).map(g => `${g.user} by ${g.grantedBy}`).join(', ')})`);

  return {
    title: `📊 teriac: the last ${days} days`,
    lines, event: 'teriac.summary', url: publicUrl ? `${publicUrl}/#metrics` : undefined,
    data: { from, to, totals: t, delivery: d, drifted: drifted.map(r => r.project), oldLocks: old.length, slowest: slow, people },
  };
};

export interface SummaryDeps {
  store: Store;
  cfg?: SummaryConfig;
  channels: Record<string, ChannelConfig>;
  people: Person[];
  env: NodeJS.ProcessEnv;
  publicUrl?: string;
  fetchImpl?: typeof fetch;
}

export class SummaryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private d: SummaryDeps;
  constructor(d: SummaryDeps) { this.d = d; }

  start() {
    if (!this.d.cfg) return;
    const tick = () => {
      void this.tick(new Date());
      this.timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
      this.timer.unref?.();
    };
    tick();
  }
  stop() { if (this.timer) clearTimeout(this.timer); }

  // Sends the summary when the schedule matches `now` (each minute claimed once in the DB).
  async tick(now: Date) {
    const c = this.d.cfg;
    if (!c || !cronMatches(parseCron(c.schedule), now, c.timezone ?? 'UTC')) return null;
    if (!this.d.store.claimDrift(`summary:${c.schedule}`, now.toISOString().slice(0, 16))) return null;
    return this.send(now);
  }

  async send(now = new Date()) {
    const c = this.d.cfg!;
    const msg = buildSummary(this.d.store, c.days ?? 7, now, this.d.publicUrl);
    const results = await notifyText(c.notify, this.d.channels, msg, { people: this.d.people, env: this.d.env, fetchImpl: this.d.fetchImpl });
    log.info('summary sent', { results });
    return results;
  }
}
