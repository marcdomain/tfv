// HTTP endpoints: webhooks, health, metrics and a small read-only API.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VcsAdapter, Platform } from './vcs/types.ts';
import type { App } from './app.ts';
import type { Store } from './store.ts';
import type { DriftScheduler } from './drift.ts';
import type { Person } from './config.ts';
import { presenter } from './present.ts';
import { Avatars } from './avatars.ts';
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
] as const) {
  try { WEB[path] = { type, body: readFileSync(join(WEB_DIR, file), 'utf-8') }; } catch { /* dashboard not shipped */ }
}
// The spinner GitHub shows in tfv's "Running…" replies (fetched by GitHub, so no auth).
let SPINNER: Buffer | null = null;
try { SPINNER = readFileSync(join(WEB_DIR, 'spinner.gif')); } catch { /* not shipped */ }

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
}

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
      return send(res, 200, metrics.render({ tfv_locks: deps.store.allLocks().length }), 'text/plain; version=0.0.4');
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
      if (req.headers['x-requested-with'] !== 'tfv') return send(res, 403, { error: 'missing X-Requested-With header' });
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
      if (isWrite && who.cookie && req.headers['x-requested-with'] !== 'tfv') return send(res, 403, { error: 'missing X-Requested-With header' });
      const need = (role: Role) => ROLE_RANK[who.role] >= ROLE_RANK[role];

      if (req.method === 'GET' && url.pathname === '/api/me') {
        const names: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', azure: 'Azure DevOps' };
        const platforms = [...new Set(Object.values(deps.platforms ?? {}))].map(p => ({ id: p, name: names[p] ?? p }));
        return send(res, 200, { name: who.name, role: who.role, via: who.via, platforms });
      }

      if (req.method === 'POST' && url.pathname === '/api/locks/unlock') {
        if (!need('admin')) return send(res, 403, { error: 'Only admins can release locks.' });
        const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
        const lock = deps.store.getLock(String(body.repo), String(body.project), String(body.workspace ?? 'default'));
        if (!lock) return send(res, 404, { error: 'no such lock' });
        deps.store.releaseLock(lock.repo, lock.project, lock.workspace);
        deps.store.audit({ repo: lock.repo, pr: lock.pr, user: who.name, action: 'unlock', project: lock.project, allowed: true, reason: `released from the dashboard (${who.via})` });
        return send(res, 200, { released: lock });
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
