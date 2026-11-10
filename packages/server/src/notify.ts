// Sends drift reports to chat channels and @mentions the people involved.
import type { ChannelConfig, Person } from './config.ts';
import type { Author } from './blame.ts';
import type { ChangeAction } from './render.ts';
import { addSecret, log } from './log.ts';

export interface DriftItem {
  address: string;
  action: ChangeAction;
  author: Author | null;           // last change to this resource's code
}

export interface ProjectDrift {
  project: string;
  engine: string;
  drift: DriftItem[];
  pending: { add: number; change: number; destroy: number; replace: number } | null;
  lastApply: { user: string; pr: number; at: string } | null;
  error?: string;
}

export interface DriftReport {
  repo: string;                    // "acme/infra"
  host: string;
  branch: string;
  sha: string;
  schedule: string;
  projects: ProjectDrift[];        // only projects with findings
  cleanCount: number;              // projects checked with nothing to report
  url?: string;
}

// ---- identities -------------------------------------------------------------

export interface Identity { name: string; email?: string; github?: string }

// GitHub "noreply" commit emails carry the login: 123+alice@users.noreply.github.com
export const githubLoginFromEmail = (email?: string): string | undefined =>
  /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email ?? '')?.[1];

export const findPerson = (people: Person[], id: Identity): Person | undefined => {
  const email = id.email?.toLowerCase();
  const login = (id.github ?? githubLoginFromEmail(id.email))?.toLowerCase();
  return people.find(p =>
    (email && p.emails?.some(e => e.toLowerCase() === email))
    || (login && p.github?.toLowerCase() === login));
};

// The people to tag for a project: resource authors, then the last applier.
export const peopleFor = (p: ProjectDrift): Identity[] => {
  const seen = new Map<string, Identity>();
  for (const d of p.drift) {
    if (!d.author) continue;
    const key = d.author.email.toLowerCase();
    if (!seen.has(key)) seen.set(key, { name: d.author.name, email: d.author.email });
  }
  if (p.lastApply) {
    const key = `gh:${p.lastApply.user.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { name: p.lastApply.user, github: p.lastApply.user });
  }
  return [...seen.values()];
};

// ---- text helpers -------------------------------------------------------------

const ACTION_TEXT: Record<string, string> = {
  update: 'changed outside Terraform', delete: 'deleted outside Terraform', create: 'created outside Terraform',
  replace: 'replaced outside Terraform', forget: 'removed', import: 'imported', move: 'moved',
};

const pendingText = (p: ProjectDrift['pending']) => {
  if (!p) return '';
  const parts = [p.add && `${p.add} to add`, p.change && `${p.change} to change`, p.replace && `${p.replace} to replace`, p.destroy && `${p.destroy} to destroy`].filter(Boolean);
  return parts.length ? `Merged but not applied: ${parts.join(', ')}` : '';
};

const short = (sha: string) => sha.slice(0, 7);
const MAX_ITEMS = 15;

export const headline = (r: DriftReport) => {
  const errors = r.projects.filter(p => p.error).length;
  const drifted = r.projects.filter(p => p.drift.length).length;
  if (errors && !drifted) return `Drift check failed in ${r.repo} (${r.branch})`;
  return `Drift detected in ${r.repo} (${r.branch}): ${drifted} project${drifted === 1 ? '' : 's'}`;
};

// ---- channels -------------------------------------------------------------------

type Fetch = typeof fetch;

export interface NotifyContext {
  people: Person[];
  env: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
}

const post = async (f: Fetch, url: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return text;
};

const secret = (env: NodeJS.ProcessEnv, name: string | undefined, what: string): string => {
  const v = name ? env[name] : undefined;
  if (!v) throw new Error(`${what}: environment variable ${name ?? '(not set)'} is empty`);
  addSecret(v);
  return v;
};

// Slack -------------------------------------------------------------------------

const slackLookups = new Map<string, string | null>();

const slackMention = async (ctx: NotifyContext, token: string | null, id: Identity): Promise<string> => {
  const person = findPerson(ctx.people, id);
  if (person?.slack) return `<@${person.slack}>`;
  const email = person?.emails?.[0] ?? (githubLoginFromEmail(id.email) ? undefined : id.email);
  if (token && email) {
    if (!slackLookups.has(email)) {
      try {
        const res = await (ctx.fetchImpl ?? fetch)(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json() as { ok: boolean; user?: { id: string } };
        slackLookups.set(email, data.ok && data.user ? data.user.id : null);
      } catch {
        slackLookups.set(email, null);
      }
    }
    const found = slackLookups.get(email);
    if (found) return `<@${found}>`;
  }
  return `*${person?.name ?? id.name}*`;
};

export const slackMessage = async (r: DriftReport, mention: (id: Identity) => Promise<string>) => {
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: headline(r).slice(0, 150) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Schedule *${r.schedule}* · commit \`${short(r.sha)}\`${r.cleanCount ? ` · ${r.cleanCount} other project${r.cleanCount === 1 ? '' : 's'} clean` : ''}${r.url ? ` · <${r.url}|open in teriac>` : ''}` }] },
  ];
  for (const p of r.projects.slice(0, 20)) {
    const lines: string[] = [`*${p.project}* · ${p.engine}`];
    if (p.error) lines.push(`:x: ${p.error.slice(0, 300)}`);
    for (const d of p.drift.slice(0, MAX_ITEMS)) {
      const who = d.author ? ` · last changed by ${await mention({ name: d.author.name, email: d.author.email })} in \`${short(d.author.sha)}\` _${d.author.subject.slice(0, 60)}_` : '';
      lines.push(`• \`${d.address}\` ${ACTION_TEXT[d.action] ?? d.action}${who}`);
    }
    if (p.drift.length > MAX_ITEMS) lines.push(`• …and ${p.drift.length - MAX_ITEMS} more`);
    const pending = pendingText(p.pending);
    if (pending) lines.push(pending);
    if (p.lastApply) lines.push(`Last applied by ${await mention({ name: p.lastApply.user, github: p.lastApply.user })} via PR #${p.lastApply.pr}`);
    blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } });
  }
  return { text: headline(r), blocks };
};

// Teams (Workflows "post to a channel when a webhook request is received") -------

export const teamsMessage = (r: DriftReport, people: Person[]) => {
  const body: unknown[] = [
    { type: 'TextBlock', size: 'Large', weight: 'Bolder', wrap: true, text: headline(r) },
    { type: 'TextBlock', isSubtle: true, spacing: 'None', wrap: true, text: `Schedule ${r.schedule} · commit ${short(r.sha)}${r.cleanCount ? ` · ${r.cleanCount} other projects clean` : ''}` },
  ];
  const entities: unknown[] = [];
  const mentioned = new Set<string>();
  const at = (id: Identity): string => {
    const person = findPerson(people, id);
    const upn = person?.teams ?? person?.emails?.[0] ?? (githubLoginFromEmail(id.email) ? undefined : id.email);
    const name = person?.name ?? id.name;
    if (!upn) return `**${name}**`;
    if (!mentioned.has(upn)) {
      mentioned.add(upn);
      entities.push({ type: 'mention', text: `<at>${name}</at>`, mentioned: { id: upn, name } });
    }
    return `<at>${name}</at>`;
  };
  for (const p of r.projects.slice(0, 20)) {
    body.push({ type: 'TextBlock', weight: 'Bolder', wrap: true, separator: true, spacing: 'Medium', text: `${p.project} · ${p.engine}` });
    if (p.error) body.push({ type: 'TextBlock', wrap: true, color: 'Attention', text: p.error.slice(0, 300) });
    const items = p.drift.slice(0, MAX_ITEMS).map(d =>
      `- \`${d.address}\` ${ACTION_TEXT[d.action] ?? d.action}${d.author ? `, last changed by ${at({ name: d.author.name, email: d.author.email })} in ${short(d.author.sha)}` : ''}`);
    if (p.drift.length > MAX_ITEMS) items.push(`- …and ${p.drift.length - MAX_ITEMS} more`);
    if (items.length) body.push({ type: 'TextBlock', wrap: true, text: items.join('\r') });
    const extra = [pendingText(p.pending), p.lastApply ? `Last applied by ${at({ name: p.lastApply.user, github: p.lastApply.user })} via PR #${p.lastApply.pr}` : ''].filter(Boolean);
    if (extra.length) body.push({ type: 'TextBlock', wrap: true, isSubtle: true, text: extra.join(' · ') });
  }
  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body,
    actions: r.url ? [{ type: 'Action.OpenUrl', title: 'Open in teriac', url: r.url }] : [],
    msteams: { entities, width: 'Full' },
  };
  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }] };
};

// Discord / Google Chat (plain markdown) ----------------------------------------

export const plainText = (r: DriftReport, mention: (id: Identity) => string, limit: number) => {
  const lines = [`**${headline(r)}**`, `Schedule ${r.schedule} · commit ${short(r.sha)}${r.url ? ` · ${r.url}` : ''}`];
  for (const p of r.projects) {
    lines.push('', `**${p.project}** · ${p.engine}`);
    if (p.error) lines.push(`❌ ${p.error.slice(0, 200)}`);
    for (const d of p.drift.slice(0, MAX_ITEMS)) {
      lines.push(`• \`${d.address}\` ${ACTION_TEXT[d.action] ?? d.action}${d.author ? `, last changed by ${mention({ name: d.author.name, email: d.author.email })} (${short(d.author.sha)})` : ''}`);
    }
    const pending = pendingText(p.pending);
    if (pending) lines.push(pending);
    if (p.lastApply) lines.push(`Last applied by ${mention({ name: p.lastApply.user, github: p.lastApply.user })} via PR #${p.lastApply.pr}`);
  }
  const text = lines.join('\n');
  return text.length > limit ? `${text.slice(0, limit - 20)}\n…(truncated)` : text;
};

// ---- dispatch -------------------------------------------------------------------

export const sendReport = async (name: string, channel: ChannelConfig, report: DriftReport, ctx: NotifyContext): Promise<void> => {
  const f = ctx.fetchImpl ?? fetch;
  switch (channel.type) {
    case 'slack': {
      const token = channel.token_env ? secret(ctx.env, channel.token_env, `channel ${name}`) : null;
      const msg = await slackMessage(report, id => slackMention(ctx, token, id));
      if (token && channel.channel) {
        const out = JSON.parse(await post(f, 'https://slack.com/api/chat.postMessage', { channel: channel.channel, ...msg, unfurl_links: false }, { Authorization: `Bearer ${token}` }));
        if (!out.ok) throw new Error(`Slack: ${out.error}`);
      } else {
        await post(f, secret(ctx.env, channel.webhook_url_env, `channel ${name}`), msg);
      }
      return;
    }
    case 'teams':
      await post(f, secret(ctx.env, channel.webhook_url_env, `channel ${name}`), teamsMessage(report, ctx.people));
      return;
    case 'discord': {
      const ids: string[] = [];
      const content = plainText(report, id => {
        const p = findPerson(ctx.people, id);
        if (p?.discord) { ids.push(p.discord); return `<@${p.discord}>`; }
        return `**${p?.name ?? id.name}**`;
      }, 1900);
      await post(f, secret(ctx.env, channel.webhook_url_env, `channel ${name}`), { content, allowed_mentions: { users: [...new Set(ids)] } });
      return;
    }
    case 'googlechat':
      await post(f, secret(ctx.env, channel.webhook_url_env, `channel ${name}`), {
        text: plainText(report, id => `*${findPerson(ctx.people, id)?.name ?? id.name}*`, 4000).replace(/\*\*/g, '*'),
      });
      return;
    case 'webhook':
      await post(f, secret(ctx.env, channel.webhook_url_env, `channel ${name}`), {
        event: 'teriac.drift',
        report,
        people: report.projects.map(p => ({ project: p.project, people: peopleFor(p).map(id => ({ ...id, person: findPerson(ctx.people, id) ?? null })) })),
      });
      return;
  }
};

export const notifyAll = async (names: string[], channels: Record<string, ChannelConfig>, report: DriftReport, ctx: NotifyContext) => {
  const results: { channel: string; ok: boolean; error?: string }[] = [];
  for (const name of names) {
    const channel = channels[name];
    if (!channel) { results.push({ channel: name, ok: false, error: 'no such channel' }); continue; }
    try {
      await sendReport(name, channel, report, ctx);
      results.push({ channel: name, ok: true });
    } catch (err) {
      log.warn('notification failed', { channel: name, err });
      results.push({ channel: name, ok: false, error: (err as Error).message });
    }
  }
  return results;
};
