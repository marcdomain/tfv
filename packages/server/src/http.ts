// HTTP endpoints: webhooks, health, metrics and a small read-only API.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VcsAdapter, Platform } from './vcs/types.ts';
import type { App } from './app.ts';
import type { Store } from './store.ts';
import { platformForHost } from './links.ts';
import type { DriftScheduler } from './drift.ts';
import type { Person } from './config.ts';
import { presenter } from './present.ts';
import { isGrantor, parseGrantRequest, announce, grantText, type NotifyDeps } from './grants.ts';
import { windowUntil } from './freeze.ts';
import { destination, type BackupScheduler } from './backup.ts';
import type { ServerConfig } from './config.ts';
import { Avatars, roundAvatarSvg } from './avatars.ts';
import {
  type AuthConfig, type Oidc, type Role, type Session, checkLogin, newSession, parseCookies, unsign,
  RateLimiter, cookie, SESSION_COOKIE, OIDC_COOKIE,
} from './auth.ts';
import { metrics } from './metrics.ts';
import { log } from './log.ts';

const MAX_BODY = 25 * 1024 * 1024; // GitHub's webhook limit

// The dashboard: a few static files, loaded once.
const WEB_DIR = join(import.meta.dirname, '..', 'web');
const WEB: Record<string, { type: string; body: string }> = {};
for (const [path, file, type] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/app.css', 'app.css', 'text/css; charset=utf-8'],
  ['/theme.js', 'theme.js', 'text/javascript; charset=utf-8'],
  ['/favicon.svg', 'logo.svg', 'image/svg+xml'],
] as const) {
  try { WEB[path] = { type, body: readFileSync(join(WEB_DIR, file), 'utf-8') }; } catch { /* dashboard not shipped */ }
}
// The spinner GitHub shows in teriac's "Running…" replies (fetched by GitHub, so no auth).
let SPINNER: Buffer | null = null;
try { SPINNER = readFileSync(join(WEB_DIR, 'spinner.gif')); } catch { /* not shipped */ }

// The server's version (packages/server/package.json), shown in the dashboard.
let VERSION = 'dev';
try { VERSION = JSON.parse(readFileSync(join(WEB_DIR, '..', 'package.json'), 'utf-8')).version ?? 'dev'; } catch { /* not shipped */ }
const STARTED_AT = new Date().toISOString();
const statsCache = new Map<string, { at: number; data: ReturnType<Store['stats']> }>();


const WEB_HEADERS = {
  // Everything comes from this server; nothing inline, nothing third-party.
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
};

const readBody = (req: IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : String(body));
};

const tokenOk = (req: IncomingMessage, token: string | undefined) => {
  if (!token) return false;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
};

export interface HttpDeps {
  app: App;
  store: Store;
  adapters: Partial<Record<Platform, VcsAdapter>>;
  auth: AuthConfig;
  oidc?: Oidc;
  ready: () => boolean;
  drift?: DriftScheduler;
  loginLimiter?: RateLimiter;
  platforms?: Record<string, Platform>;       // host → platform, for links
  people?: Person[];
  avatars?: Avatars;
  grants?: NotifyDeps;                        // emergency access (break_glass in repos.yaml)
  config?: ServerConfig;                      // for the Guardrails page (settings only, no secrets)
  backups?: BackupScheduler;                  // scheduled database backups (TERIAC_BACKUP_*)
}

// The guardrails in force, for the dashboard: freezes (on now or not), protected resources,
// risk and policy settings, the secret scan, and each repo entry's approval settings.
const safetySummary = (c: ServerConfig | undefined, now = new Date()) => {
  if (!c) return null;
  const freeze = (w: NonNullable<ServerConfig['freezes']>[number], scope: string) => ({
    scope, name: w.name, projects: w.projects ?? [], schedule: w.schedule ?? null, hours: w.hours ?? null,
    from: w.from ?? null, to: w.to ?? null, timezone: w.timezone ?? 'UTC', override: w.override ?? [], until: windowUntil(w, now),
  });
  const prot = (r: NonNullable<ServerConfig['protected']>[number], scope: string) => ({ scope, projects: r.projects ?? [], resources: r.resources, override: r.override ?? [] });
  return {
    freezes: [...(c.freezes ?? []).map(w => freeze(w, 'every repo')), ...c.repos.flatMap(r => (r.freezes ?? []).map(w => freeze(w, r.id)))],
    protected: [...(c.protected ?? []).map(r => prot(r, 'every repo')), ...c.repos.flatMap(r => (r.protected ?? []).map(x => prot(x, r.id)))],
    secretScan: { mode: c.secretScan?.mode ?? 'redact', patterns: (c.secretScan?.patterns ?? []).map(p => p.name) },
    policies: { mode: c.policies?.mode ?? 'off', builtin: c.policies?.builtin ?? [], disable: c.policies?.disable ?? [], rules: (c.policies?.rules ?? []).length, override: c.policies?.override ?? [] },
    risk: c.risk ?? null,
    breakGlass: c.breakGlass ? { grantors: c.breakGlass.grantors, maxHours: c.breakGlass.max_hours ?? 4 } : null,
    summary: c.summary ? { schedule: c.summary.schedule, timezone: c.summary.timezone ?? 'UTC', notify: c.summary.notify } : null,
    repos: c.repos.map(r => ({
      id: r.id, reapproveOnChange: r.reapprove_on_change ?? true, keepApprovalOnRebase: r.keep_approval_on_rebase ?? false,
      staleBase: r.stale_base ?? 'warn', verifyPlan: r.verify_plan ?? true, secretScan: r.secret_scan ?? null,
    })),
  };
};

const defaultLimiter = new RateLimiter(10, 15 * 60_000);

// Who is calling: an API token (automation, admin) or a dashboard session cookie.
const whoIs = (req: IncomingMessage, auth: AuthConfig): (Session & { cookie: boolean }) | null => {
  if (req.headers.authorization) {
    return tokenOk(req, auth.apiToken)
      ? { sub: 'api-token', name: 'api-token', role: 'admin', via: 'token', exp: Infinity, cookie: false }
      : null;
  }
  const s = unsign<Session>(parseCookies(req.headers.cookie)[SESSION_COOKIE], auth.sessionSecret);
  return s ? { ...s, cookie: true } : null;
};

const ROLE_RANK: Record<Role, number> = { viewer: 1, admin: 2 };

const redirect = (res: ServerResponse, location: string, setCookie?: string[]) => {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...(setCookie ? { 'Set-Cookie': setCookie } : {}) });
  res.end();
};

export const createHttpServer = (deps: HttpDeps): Server => {
  const show = presenter(deps.platforms ?? {}, deps.people ?? []);
  return createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/readyz') {
      return deps.ready() ? send(res, 200, { ok: true }) : send(res, 503, { ok: false });
    }
    if (req.method === 'GET' && url.pathname === '/assets/spinner.gif' && SPINNER) {
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return res.end(SPINNER);
    }
    if (req.method === 'GET' && url.pathname === '/metrics') {
      const extra: Record<string, number> = { teriac_locks: deps.store.allLocks().length };
      if (deps.backups) {
        const recent = deps.store.recentBackups(50);
        const ok = recent.find(b => b.ok);
        extra.teriac_backup_last_ok = recent[0] ? (recent[0].ok ? 1 : 0) : 1;
        extra.teriac_backup_last_success_timestamp_seconds = ok ? Math.floor(Date.parse(ok.at) / 1000) : 0;
        if (ok?.bytes) extra.teriac_backup_last_size_bytes = ok.bytes;
      }
      return send(res, 200, metrics.render(extra), 'text/plain; version=0.0.4');
    }

    const hook = /^\/events\/([a-z]+)$/.exec(url.pathname);
    if (req.method === 'POST' && hook) {
      const adapter = deps.adapters[hook[1] as Platform];
      if (!adapter) return send(res, 404, { error: 'platform not configured' });
      const raw = await readBody(req);
      if (!adapter.verify(req.headers, raw)) {
        log.warn('webhook signature rejected', { platform: hook[1] });
        return send(res, 401, { error: 'bad signature' });
      }
      const event = adapter.parse(req.headers, JSON.parse(raw.toString('utf-8')));
      metrics.webhook(adapter.platform, event.kind);
      // Answer now; platforms time out webhooks after ~10s and plans take longer.
      send(res, 202, { accepted: event.kind });
      deps.app.handle(adapter, event).catch(err => log.error('event handling failed', { err }));
      return;
    }

    // ---- sign-in -----------------------------------------------------------
    const { auth } = deps;
    if (req.method === 'GET' && url.pathname === '/auth/config') {
      return send(res, 200, {
        password: auth.users.length > 0,
        oidc: auth.oidc ? { name: auth.oidc.name } : null,
        token: !!auth.apiToken,
      });
    }
    if (req.method === 'POST' && url.pathname === '/auth/login') {
      if (req.headers['x-requested-with'] !== 'teriac') return send(res, 403, { error: 'missing X-Requested-With header' });
      const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
      const username = String(body.username ?? '');
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
      const loginLimiter = deps.loginLimiter ?? defaultLimiter;
      if (!loginLimiter.allow(`ip:${ip}`) || !loginLimiter.allow(`user:${username}`)) {
        return send(res, 429, { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
      }
      const user = checkLogin(auth.users, username, String(body.password ?? ''));
      if (!user) {
        log.warn('dashboard sign-in failed', { username, ip });
        return send(res, 401, { error: 'Wrong username or password.' });
      }
      loginLimiter.reset(`user:${username}`);
      const { session, setCookie } = newSession(auth, { sub: user.username, name: user.name ?? user.username, role: user.role ?? 'viewer', via: 'password' });
      res.setHeader('Set-Cookie', setCookie);
      log.info('dashboard sign-in', { user: session.sub, via: 'password', role: session.role });
      return send(res, 200, { name: session.name, role: session.role });
    }
    if (req.method === 'GET' && url.pathname === '/auth/oidc/login') {
      if (!deps.oidc) return send(res, 404, { error: 'single sign-on is not configured' });
      const { url: to, setCookie } = await deps.oidc.start(auth.sessionSecret, auth);
      return redirect(res, to, [setCookie]);
    }
    if (req.method === 'GET' && url.pathname === '/auth/oidc/callback') {
      if (!deps.oidc) return send(res, 404, { error: 'single sign-on is not configured' });
      const clearState = cookie(OIDC_COOKIE, '', auth, 0);
      try {
        const who = await deps.oidc.finish(url.searchParams, parseCookies(req.headers.cookie)[OIDC_COOKIE], auth.sessionSecret);
        const { session, setCookie } = newSession(auth, who);
        log.info('dashboard sign-in', { user: session.sub, via: 'oidc', role: session.role });
        return redirect(res, '/#overview', [setCookie, clearState]);
      } catch (err) {
        log.warn('single sign-on failed', { err });
        return redirect(res, `/#signin-error=${encodeURIComponent((err as Error).message)}`, [clearState]);
      }
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, '', auth, 0));
      return send(res, 200, { ok: true });
    }

    // Round avatars for PR comments: public (GitHub's image proxy fetches them), known hosts only.
    const round = /^\/avatars\/round\/([^/]+)\/([^/]+)\.svg$/.exec(url.pathname);
    if (req.method === 'GET' && round && deps.avatars) {
      const host = decodeURIComponent(round[1]);
      const login = decodeURIComponent(round[2]);
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) || !deps.avatars.knows(host)) return send(res, 404, { error: 'not found' });
      const img = await deps.avatars.get(host, login);
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'" });
      return res.end(roundAvatarSvg(login, img));
    }

    // Avatars, served from here (signed-in users only; known hosts only).
    const av = /^\/avatars\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && av) {
      if (!whoIs(req, auth) || !deps.avatars) return send(res, 404, { error: 'not found' });
      const img = await deps.avatars.get(decodeURIComponent(av[1]), decodeURIComponent(av[2]));
      if (!img) return send(res, 404, { error: 'no avatar' });
      res.writeHead(200, { 'Content-Type': img.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return res.end(img.body);
    }

    // ---- API: viewers read, admins act ----------------------------------------
    if (url.pathname.startsWith('/api/')) {
      const who = whoIs(req, auth);
      if (!who) return send(res, 401, { error: 'sign in first' });
      const isWrite = req.method !== 'GET';
      // Browsers can't add this header to a cross-site request without CORS approval.
      if (isWrite && who.cookie && req.headers['x-requested-with'] !== 'teriac') return send(res, 403, { error: 'missing X-Requested-With header' });
      const need = (role: Role) => ROLE_RANK[who.role] >= ROLE_RANK[role];

      if (req.method === 'GET' && url.pathname === '/api/me') {
        const names: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', azure: 'Azure DevOps' };
        const platforms = [...new Set(Object.values(deps.platforms ?? {}))].map(p => ({ id: p, name: names[p] ?? p }));
        return send(res, 200, { name: who.name, role: who.role, via: who.via, platforms, version: VERSION });
      }

      if (req.method === 'GET' && url.pathname === '/api/stats') {
        // Either the last N days, or a custom from/to (dates or ISO times; "to" is exclusive).
        const date = (k: string) => { const v = url.searchParams.get(k); const t = v ? Date.parse(v) : NaN; return Number.isNaN(t) ? null : t; };
        let fromMs = date('from');
        let toMs = date('to');
        if (fromMs === null) {
          const n = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
          fromMs = Date.now() - n * 864e5;
          toMs = null;
        }
        if (toMs !== null && toMs <= fromMs) return send(res, 400, { error: '"to" must be after "from"' });
        if ((toMs ?? Date.now()) - fromMs > 3 * 366 * 864e5) return send(res, 400, { error: 'the range can be at most 3 years' });
        const from = new Date(fromMs).toISOString();
        const to = toMs === null ? undefined : new Date(toMs).toISOString();
        const days = Math.max(1, Math.ceil(((toMs ?? Date.now()) - fromMs) / 864e5));
        // Cached for 30 seconds: dashboards refresh often, and the numbers barely move.
        const cacheKey = `${url.searchParams.get('days') ?? ''}|${from.slice(0, 16)}|${to ?? ''}`;
        const hit = statsCache.get(cacheKey);
        let stats = hit && Date.now() - hit.at < 30_000 ? hit.data : null;
        if (!stats) {
          stats = deps.store.stats(from, to);
          statsCache.set(cacheKey, { at: Date.now(), data: stats });
          if (statsCache.size > 50) statsCache.delete(statsCache.keys().next().value!);
        }
        return send(res, 200, {
          days, to: to ?? null, ...stats,
          server: {
            version: VERSION, node: process.version, uptime: Math.round(process.uptime()),
            memory: process.memoryUsage().rss, queue: deps.app.runQueue ?? null, startedAt: STARTED_AT,
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/locks/unlock') {
        if (!need('admin')) return send(res, 403, { error: 'Only admins can release locks.' });
        const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
        const lock = deps.store.getLock(String(body.repo), String(body.project), String(body.workspace ?? 'default'));
        if (!lock) return send(res, 404, { error: 'no such lock' });
        deps.store.releaseLock(lock.repo, lock.project, lock.workspace);
        deps.store.audit({ repo: lock.repo, pr: lock.pr, user: who.name, action: 'unlock', project: lock.project, allowed: true, reason: `released from the dashboard (${who.via})` });
        const host = lock.repo.split('/')[0];
        const adapter = deps.adapters[platformForHost(host, deps.platforms ?? {})];
        const notified = await deps.app.dashboardUnlock(adapter, lock, who);
        return send(res, 200, { released: lock, notified });
      }

      // ---- emergency access ----
      if (url.pathname === '/api/grants' && req.method === 'GET') {
        const g = deps.grants;
        return send(res, 200, {
          enabled: !!g?.cfg,
          canGrant: isGrantor(who, g?.cfg),
          maxHours: g?.cfg?.max_hours ?? 4,
          active: deps.store.activeGrants(),
          recent: deps.store.listGrants(50),
        });
      }
      if (url.pathname === '/api/grants' && req.method === 'POST') {
        const g = deps.grants;
        if (!g?.cfg) return send(res, 404, { error: 'Emergency access is not set up (break_glass in repos.yaml).' });
        if (!isGrantor(who, g.cfg)) return send(res, 403, { error: 'You are not allowed to grant emergency access.' });
        const parsed = parseGrantRequest(JSON.parse((await readBody(req)).toString('utf-8') || '{}'), g.cfg);
        if ('error' in parsed) return send(res, 400, parsed);
        const grant = deps.store.createGrant({ ...parsed, grantedBy: `${who.name} (${who.via})`, expiresAt: new Date(Date.now() + parsed.hours * 3_600_000).toISOString() });
        deps.store.audit({ repo: grant.repo, pr: 0, user: grant.user, action: 'break_glass_granted', project: grant.projects.join(',') || '*', allowed: true, reason: `emergency access #${grant.id} by ${grant.grantedBy} for ${parsed.hours}h: ${grantText(grant)}. Reason: ${grant.reason}` });
        log.warn('emergency access granted', { id: grant.id, user: grant.user, by: grant.grantedBy, hours: parsed.hours });
        void announce(g, `🚨 Emergency access #${grant.id} granted to ${grant.user}`, grant, 'teriac.break_glass.granted').catch(() => {});
        return send(res, 201, grant);
      }
      const revoke = /^\/api\/grants\/(\d+)\/revoke$/.exec(url.pathname);
      if (revoke && req.method === 'POST') {
        const g = deps.grants;
        if (!need('admin') && !isGrantor(who, g?.cfg)) return send(res, 403, { error: 'Only admins and grantors can revoke emergency access.' });
        const grant = deps.store.getGrant(Number(revoke[1]));
        if (!grant) return send(res, 404, { error: 'no such grant' });
        if (!deps.store.revokeGrant(grant.id, who.name)) return send(res, 409, { error: 'already revoked' });
        deps.store.audit({ repo: grant.repo, pr: 0, user: grant.user, action: 'break_glass_revoked', project: grant.projects.join(',') || '*', allowed: true, reason: `emergency access #${grant.id} revoked by ${who.name}` });
        if (g) void announce(g, `🔒 Emergency access #${grant.id} for ${grant.user} revoked by ${who.name}`, grant, 'teriac.break_glass.revoked').catch(() => {});
        return send(res, 200, deps.store.getGrant(grant.id));
      }

      // ---- backups ----
      if (url.pathname === '/api/backups' && req.method === 'GET') {
        const c = deps.config?.backup;
        if (!c || !deps.backups) return send(res, 200, { enabled: false });
        return send(res, 200, {
          enabled: true, schedule: c.schedule, timezone: c.timezone, destination: destination(c),
          next: deps.backups.next(), running: deps.backups.busy, canRun: need('admin'),
          runs: deps.store.recentBackups(Math.min(100, Number(url.searchParams.get('limit') ?? 10))),
        });
      }
      if (url.pathname === '/api/backups/run' && req.method === 'POST') {
        if (!deps.backups) return send(res, 404, { error: 'Backups are off. Set backup.enabled (TERIAC_BACKUP_ENABLED) to turn them on.' });
        if (!need('admin')) return send(res, 403, { error: 'Only admins can start a backup.' });
        const run = await deps.backups.run('manual');
        deps.store.audit({ repo: '*', pr: 0, user: who.name, action: 'backup', project: '*', allowed: run.ok, reason: run.ok ? `backup ${run.name} from the dashboard (${who.via})` : `backup from the dashboard failed: ${run.error}` });
        return send(res, run.ok ? 200 : 502, run);
      }

      if (req.method === 'POST' && url.pathname === '/api/drift/run') {
        if (!need('admin')) return send(res, 403, { error: 'Only admins can start drift checks.' });
        const entry = deps.drift?.schedules.find(e => e.key === url.searchParams.get('key'));
        if (!entry) return send(res, 404, { error: 'no schedule with that key; see GET /api/drift/schedules' });
        send(res, 202, { started: entry.key });
        deps.drift!.run(entry).catch(err => log.error('manual drift run failed', { err }));
        return;
      }

      if (req.method === 'GET') {
        if (url.pathname === '/api/locks') return send(res, 200, deps.store.allLocks().map(show.lock));
        if (url.pathname === '/api/runs') {
          return send(res, 200, deps.store.recentRuns(Math.min(200, Number(url.searchParams.get('limit') ?? 50))).map(r => ({ ...show.run(r), output: undefined })));
        }
        const run = /^\/api\/runs\/(\d+)$/.exec(url.pathname);
        if (run) {
          const r = deps.store.getRun(Number(run[1]));
          return r ? send(res, 200, show.run(r)) : send(res, 404, { error: 'not found' });
        }
        if (url.pathname === '/api/audit') return send(res, 200, deps.store.auditLog(200).map(show.audit));
        const qp = url.searchParams;
        const str = (k: string) => (qp.get(k) ?? '').trim() || undefined;
        const num = (k: string) => (qp.get(k) ? Number(qp.get(k)) : undefined);
        const oneOf = <T extends string>(k: string, allowed: readonly T[]) => {
          const v = str(k);
          return v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
        };
        const time = (k: string) => {
          const v = str(k);
          return v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined;
        };
        if (url.pathname === '/api/runs/search') {
          const r = deps.store.searchRuns({
            q: str('q'), user: str('user'), project: str('project'), repo: str('repo'),
            status: oneOf('status', ['failed', 'applied', 'destroys', 'changes', 'nochanges', 'running'] as const),
            kind: oneOf('kind', ['plan', 'apply'] as const),
            from: time('from'), to: time('to'),
            sort: oneOf('sort', ['newest', 'oldest', 'project', 'user', 'changes'] as const),
            limit: num('limit'), offset: num('offset'),
          });
          return send(res, 200, { total: r.total, items: r.items.map(show.run) });
        }
        if (url.pathname === '/api/audit/search') {
          const allowed = str('result');
          const r = deps.store.searchAudit({
            q: str('q'), user: str('user'), project: str('project'), action: str('action'),
            allowed: allowed === 'allowed' ? true : allowed === 'denied' ? false : undefined,
            from: time('from'), to: time('to'), limit: num('limit'), offset: num('offset'),
          });
          return send(res, 200, { total: r.total, items: r.items.map(show.audit) });
        }
        if (url.pathname === '/api/facets') return send(res, 200, { ...deps.store.facets(), rules: deps.store.findingRules() });
        if (url.pathname === '/api/policy/search') {
          const r = deps.store.searchFindings({
            q: str('q'), project: str('project'), rule: str('rule'),
            severity: oneOf('severity', ['low', 'medium', 'high', 'critical'] as const),
            mode: oneOf('mode', ['audit', 'enforce'] as const),
            from: time('from'), to: time('to'), limit: num('limit'), offset: num('offset'),
          });
          return send(res, 200, { total: r.total, items: r.items.map(show.finding) });
        }
        if (url.pathname === '/api/projects') {
          return send(res, 200, deps.store.projectSummaries().map(p => ({
            ...p, lastRun: show.run(p.lastRun), lastApply: p.lastApply ? show.run(p.lastApply) : null, lock: p.lock ? show.lock(p.lock) : null,
          })));
        }
        if (url.pathname === '/api/ping') return send(res, 200, { ok: true });
        if (url.pathname === '/api/safety') return send(res, 200, safetySummary(deps.config) ?? { error: 'not available' });
        if (url.pathname === '/api/drift') return send(res, 200, deps.store.recentDrift(200).map(show.drift));
        if (url.pathname === '/api/drift/schedules') {
          return send(res, 200, (deps.drift?.schedules ?? []).map(e => ({
            key: e.key, source: e.source, repo: e.repo.fullName, branch: e.branch, name: e.spec.name ?? null,
            schedule: e.spec.schedule, timezone: e.spec.timezone ?? 'UTC', projects: e.spec.projects,
            notify: e.spec.notify, next: deps.drift!.next(e)?.toISOString() ?? null,
          })));
        }
      }
      return send(res, 404, { error: 'not found' });
    }

    const page = req.method === 'GET' ? WEB[url.pathname] : undefined;
    if (page) {
      res.writeHead(200, { 'Content-Type': page.type, ...WEB_HEADERS });
      return res.end(page.body);
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    log.error('request failed', { path: url.pathname, err });
    if (!res.headersSent) send(res, 400, { error: 'bad request' });
  }
});
};
