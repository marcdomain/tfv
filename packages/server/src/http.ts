// HTTP endpoints: webhooks, health, metrics and a small read-only API.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { VcsAdapter, Platform } from './vcs/types.ts';
import type { App } from './app.ts';
import type { Store } from './store.ts';
import type { DriftScheduler } from './drift.ts';
import { metrics } from './metrics.ts';
import { log } from './log.ts';

const MAX_BODY = 25 * 1024 * 1024; // GitHub's webhook limit

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
  apiToken?: string;
  ready: () => boolean;
  drift?: DriftScheduler;
}

export const createHttpServer = (deps: HttpDeps): Server => createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/readyz') {
      return deps.ready() ? send(res, 200, { ok: true }) : send(res, 503, { ok: false });
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

    // Run a drift schedule now: POST /api/drift/run?key=<schedule key>
    if (req.method === 'POST' && url.pathname === '/api/drift/run') {
      if (!tokenOk(req, deps.apiToken)) return send(res, 401, { error: 'unauthorized' });
      const entry = deps.drift?.schedules.find(e => e.key === url.searchParams.get('key'));
      if (!entry) return send(res, 404, { error: 'no schedule with that key; see GET /api/drift/schedules' });
      send(res, 202, { started: entry.key });
      deps.drift!.run(entry).catch(err => log.error('manual drift run failed', { err }));
      return;
    }

    // Read-only API for the dashboard (M4). Off unless TFV_API_TOKEN is set.
    if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
      if (!tokenOk(req, deps.apiToken)) return send(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/api/locks') return send(res, 200, deps.store.allLocks());
      if (url.pathname === '/api/runs') {
        return send(res, 200, deps.store.recentRuns(Math.min(200, Number(url.searchParams.get('limit') ?? 50))).map(r => ({ ...r, output: undefined })));
      }
      const run = /^\/api\/runs\/(\d+)$/.exec(url.pathname);
      if (run) {
        const r = deps.store.getRun(Number(run[1]));
        return r ? send(res, 200, r) : send(res, 404, { error: 'not found' });
      }
      if (url.pathname === '/api/audit') return send(res, 200, deps.store.auditLog(200));
      if (url.pathname === '/api/drift') return send(res, 200, deps.store.recentDrift(200));
      if (url.pathname === '/api/drift/schedules') {
        return send(res, 200, (deps.drift?.schedules ?? []).map(e => ({
          key: e.key, source: e.source, repo: e.repo.fullName, branch: e.branch, name: e.spec.name ?? null,
          schedule: e.spec.schedule, timezone: e.spec.timezone ?? 'UTC', projects: e.spec.projects,
          notify: e.spec.notify, next: deps.drift!.next(e)?.toISOString() ?? null,
        })));
      }
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, 'tfv-server is running. The dashboard arrives in a later release.', 'text/plain');
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    log.error('request failed', { path: url.pathname, err });
    if (!res.headersSent) send(res, 400, { error: 'bad request' });
  }
});
