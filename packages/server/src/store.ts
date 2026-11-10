// SQLite storage (built into Node): locks, runs and the audit log.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type RunKind = 'plan' | 'apply';
export type RunStatus = 'queued' | 'running' | 'success' | 'failed';

export interface Lock {
  repo: string;
  project: string;
  workspace: string;
  pr: number;
  user: string;
  createdAt: string;
}

export interface Run {
  id: number;
  repo: string;
  pr: number;
  project: string;
  workspace: string;
  kind: RunKind;
  status: RunStatus;
  headSha: string;
  user: string;
  startedAt: string;
  finishedAt: string | null;
  engine: string;             // e.g. "terraform 1.9.8" or "terragrunt 0.83.2 + opentofu 1.8.5"
  summary: string | null;     // JSON (render.ts PlanSummary)
  output: string;             // redacted console output
  planPath: string | null;
  hasChanges: boolean;
  destroys: number;           // deletes + replaces
  targets: string[];          // -target addresses for a targeted plan
  prAuthor: string;           // who opened the PR
  dir: string;                // project folder in the repo
  policy: string | null;      // JSON PolicyResult: mode and findings
  mocks: string[];            // dependencies whose mock outputs this plan used; for a failed plan,
                              // dependencies it couldn't read (not applied yet, no mock_outputs)
  providers: string[];        // e.g. "hashicorp/aws 5.70.0"
  usage: { cpuSeconds: number; peakMemory: number; peakProcesses: number } | null;
  applied: { added: number; changed: number; destroyed: number } | null;
}

export interface RunQuery {
  q?: string;                 // matches project, repo, user, PR author, PR number
  user?: string;              // ran it or opened the PR
  project?: string;
  repo?: string;
  status?: 'failed' | 'applied' | 'destroys' | 'changes' | 'nochanges' | 'running';
  kind?: 'plan' | 'apply';
  from?: string;              // ISO time, inclusive
  to?: string;                // ISO time, exclusive
  sort?: 'newest' | 'oldest' | 'project' | 'user' | 'changes';
  limit?: number;
  offset?: number;
}

export interface AuditQuery {
  q?: string;
  user?: string;
  project?: string;
  action?: string;
  allowed?: boolean;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ProjectSummary {
  repo: string;
  project: string;
  workspace: string;
  runs: number;
  lastRun: Run;
  lastApply: Run | null;
  lock: Lock | null;
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, c => `\\${c}`)}%`;

export interface AuditEntry {
  at: string;
  repo: string;
  pr: number;
  user: string;
  action: string;
  project: string;
  allowed: boolean;
  reason: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS locks (
  repo TEXT NOT NULL, project TEXT NOT NULL, workspace TEXT NOT NULL,
  pr INTEGER NOT NULL, user TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (repo, project, workspace)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL, pr INTEGER NOT NULL, project TEXT NOT NULL, workspace TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, head_sha TEXT NOT NULL, user TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, engine TEXT NOT NULL DEFAULT '',
  summary TEXT, output TEXT NOT NULL DEFAULT '', plan_path TEXT,
  has_changes INTEGER NOT NULL DEFAULT 0, destroys INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_pr ON runs (repo, pr, project, kind, id);
CREATE TABLE IF NOT EXISTS drift_claims (
  schedule_key TEXT NOT NULL, minute TEXT NOT NULL, PRIMARY KEY (schedule_key, minute)
);
CREATE TABLE IF NOT EXISTS drift_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, schedule_key TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL,
  sha TEXT NOT NULL, project TEXT NOT NULL, status TEXT NOT NULL, fingerprint TEXT NOT NULL,
  finding TEXT NOT NULL, notified TEXT, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drift_runs_key ON drift_runs (schedule_key, project, id);
CREATE TABLE IF NOT EXISTS policy_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, repo TEXT NOT NULL, pr INTEGER NOT NULL,
  project TEXT NOT NULL, user TEXT NOT NULL, rule TEXT NOT NULL, severity TEXT NOT NULL, address TEXT NOT NULL,
  message TEXT NOT NULL, mode TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS policy_findings_at ON policy_findings (id);
CREATE TABLE IF NOT EXISTS bot_comments (
  repo TEXT NOT NULL, comment_id TEXT NOT NULL, pr INTEGER NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (repo, comment_id)
);
CREATE TABLE IF NOT EXISTS pr_comments (
  repo TEXT NOT NULL, pr INTEGER NOT NULL, kind TEXT NOT NULL, comment_id TEXT NOT NULL, PRIMARY KEY (repo, pr, kind)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, repo TEXT NOT NULL, pr INTEGER NOT NULL,
  user TEXT NOT NULL, action TEXT NOT NULL, project TEXT NOT NULL, allowed INTEGER NOT NULL, reason TEXT NOT NULL
);
`;

const toRun = (r: Record<string, any>): Run => ({
  id: r.id, repo: r.repo, pr: r.pr, project: r.project, workspace: r.workspace,
  kind: r.kind, status: r.status, headSha: r.head_sha, user: r.user,
  startedAt: r.started_at, finishedAt: r.finished_at, engine: r.engine,
  summary: r.summary, output: r.output, planPath: r.plan_path,
  hasChanges: !!r.has_changes, destroys: r.destroys,
  targets: r.targets ? JSON.parse(r.targets) : [],
  prAuthor: r.pr_author ?? '',
  dir: r.dir ?? '',
  policy: r.policy ?? null,
  mocks: r.mocks ? JSON.parse(r.mocks) : [],
  providers: r.providers ? JSON.parse(r.providers) : [],
  usage: r.usage ? JSON.parse(r.usage) : null,
  applied: r.applied ? JSON.parse(r.applied) : null,
});

const toLock = (r: Record<string, any>): Lock => ({
  repo: r.repo, project: r.project, workspace: r.workspace, pr: r.pr, user: r.user, createdAt: r.created_at,
});

const now = () => new Date().toISOString();

export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    // Columns added after the first release.
    const cols = this.db.prepare('PRAGMA table_info(runs)').all().map((c: Record<string, any>) => c.name);
    if (!cols.includes('targets')) this.db.exec(`ALTER TABLE runs ADD COLUMN targets TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('pr_author')) this.db.exec(`ALTER TABLE runs ADD COLUMN pr_author TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('dir')) this.db.exec(`ALTER TABLE runs ADD COLUMN dir TEXT NOT NULL DEFAULT ''`);
    if (!cols.includes('policy')) this.db.exec('ALTER TABLE runs ADD COLUMN policy TEXT');
    if (!cols.includes('mocks')) this.db.exec('ALTER TABLE runs ADD COLUMN mocks TEXT');
    if (!cols.includes('providers')) this.db.exec('ALTER TABLE runs ADD COLUMN providers TEXT');
    if (!cols.includes('usage')) this.db.exec('ALTER TABLE runs ADD COLUMN usage TEXT');
    if (!cols.includes('applied')) this.db.exec('ALTER TABLE runs ADD COLUMN applied TEXT');
    // The Metrics page reads runs by start time.
    this.db.exec('CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS audit_at ON audit (at)');
  }

  close() { this.db.close(); }

  // ---- locks ----

  // Takes the lock for `pr`, or returns the lock another PR holds.
  acquireLock(repo: string, project: string, workspace: string, pr: number, user: string): { ok: true } | { ok: false; heldBy: Lock } {
    const existing = this.getLock(repo, project, workspace);
    if (existing && existing.pr !== pr) return { ok: false, heldBy: existing };
    if (!existing) {
      this.db.prepare('INSERT INTO locks (repo, project, workspace, pr, user, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(repo, project, workspace, pr, user, now());
    }
    return { ok: true };
  }

  getLock(repo: string, project: string, workspace: string): Lock | null {
    const r = this.db.prepare('SELECT * FROM locks WHERE repo = ? AND project = ? AND workspace = ?').get(repo, project, workspace);
    return r ? toLock(r) : null;
  }

  locksForPr(repo: string, pr: number): Lock[] {
    return this.db.prepare('SELECT * FROM locks WHERE repo = ? AND pr = ? ORDER BY project').all(repo, pr).map(toLock);
  }

  allLocks(): Lock[] {
    return this.db.prepare('SELECT * FROM locks ORDER BY repo, project').all().map(toLock);
  }

  releaseLock(repo: string, project: string, workspace: string): void {
    this.db.prepare('DELETE FROM locks WHERE repo = ? AND project = ? AND workspace = ?').run(repo, project, workspace);
  }

  forgetPrComments(repo: string, pr: number): void {
    this.db.prepare('DELETE FROM pr_comments WHERE repo = ? AND pr = ?').run(repo, pr);
  }

  releasePrLocks(repo: string, pr: number): number {
    return Number(this.db.prepare('DELETE FROM locks WHERE repo = ? AND pr = ?').run(repo, pr).changes);
  }

  // ---- runs ----

  startRun(r: { repo: string; pr: number; project: string; workspace: string; kind: RunKind; headSha: string; user: string; targets?: string[]; prAuthor?: string; dir?: string }): number {
    const res = this.db.prepare(
      'INSERT INTO runs (repo, pr, project, workspace, kind, status, head_sha, user, started_at, targets, pr_author, dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(r.repo, r.pr, r.project, r.workspace, r.kind, 'running', r.headSha, r.user, now(), r.targets?.length ? JSON.stringify(r.targets) : '', r.prAuthor ?? '', r.dir ?? '');
    return Number(res.lastInsertRowid);
  }

  finishRun(id: number, r: { status: RunStatus; engine?: string; summary?: string | null; output: string; planPath?: string | null; hasChanges?: boolean; destroys?: number; policy?: string | null; mocks?: string[]; providers?: string[]; usage?: object | null; applied?: object | null }): void {
    this.db.prepare(
      'UPDATE runs SET status = ?, finished_at = ?, engine = ?, summary = ?, output = ?, plan_path = ?, has_changes = ?, destroys = ?, policy = ?, mocks = ?, providers = ?, usage = ?, applied = ? WHERE id = ?',
    ).run(r.status, now(), r.engine ?? '', r.summary ?? null, r.output, r.planPath ?? null, r.hasChanges ? 1 : 0, r.destroys ?? 0, r.policy ?? null, r.mocks?.length ? JSON.stringify(r.mocks) : null, r.providers?.length ? JSON.stringify(r.providers) : null, r.usage ? JSON.stringify(r.usage) : null, r.applied ? JSON.stringify(r.applied) : null, id);
  }

  saveFindings(run: Run, mode: string, findings: { rule: string; severity: string; address: string; message: string }[]): void {
    const stmt = this.db.prepare('INSERT INTO policy_findings (run_id, repo, pr, project, user, rule, severity, address, message, mode, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const f of findings) stmt.run(run.id, run.repo, run.pr, run.project, run.user, f.rule, f.severity, f.address, f.message, mode, now());
  }

  searchFindings(q: { q?: string; project?: string; rule?: string; severity?: string; mode?: string; from?: string; to?: string; limit?: number; offset?: number }): { total: number; items: Record<string, unknown>[] } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.q) {
      where.push(`(rule LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR user LIKE ? ESCAPE '\\')`);
      const p = like(q.q);
      args.push(p, p, p, p, p);
    }
    for (const k of ['project', 'rule', 'severity', 'mode'] as const) if (q[k]) { where.push(`${k} = ?`); args.push(q[k]!); }
    if (q.from) { where.push('at >= ?'); args.push(q.from); }
    if (q.to) { where.push('at < ?'); args.push(q.to); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM policy_findings ${w}`).get(...args) as { n: number }).n);
    const items = this.db.prepare(`SELECT * FROM policy_findings ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(500, Math.max(1, q.limit ?? 100)), Math.max(0, q.offset ?? 0)) as Record<string, unknown>[];
    return { total, items };
  }

  findingRules(): string[] {
    return this.db.prepare('SELECT DISTINCT rule AS v FROM policy_findings ORDER BY v').all().map((r: Record<string, any>) => String(r.v));
  }

  getRun(id: number): Run | null {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return r ? toRun(r) : null;
  }

  // Newest run of each kind per project for a PR.
  latestRuns(repo: string, pr: number, kind: RunKind): Run[] {
    return this.db.prepare(
      `SELECT * FROM runs WHERE id IN (SELECT MAX(id) FROM runs WHERE repo = ? AND pr = ? AND kind = ? GROUP BY project, workspace) ORDER BY project`,
    ).all(repo, pr, kind).map(toRun);
  }

  recentRuns(limit = 50): Run[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit).map(toRun);
  }

  // Plans are discarded on unlock; runs stay for history.
  discardPlans(repo: string, pr: number, project?: string): void {
    if (project) {
      this.db.prepare(`UPDATE runs SET plan_path = NULL WHERE repo = ? AND pr = ? AND kind = 'plan' AND project = ?`).run(repo, pr, project);
      return;
    }
    this.db.prepare(`UPDATE runs SET plan_path = NULL WHERE repo = ? AND pr = ? AND kind = 'plan'`).run(repo, pr);
  }

  // Everything the Metrics page shows, for runs started at or after `from`.
  stats(from: string, to = '9999-12-31T00:00:00.000Z') {
    const all = <T>(sql: string, ...args: (string | number)[]) => this.db.prepare(sql).all(...args) as T[];
    const secs = `(julianday(finished_at) - julianday(started_at)) * 86400`;
    const daily = all<{ day: string; kind: string; status: string; n: number }>(
      `SELECT substr(started_at, 1, 10) AS day, kind, status, count(*) AS n FROM runs WHERE started_at >= ? AND started_at < ? GROUP BY day, kind, status ORDER BY day`, from, to);
    const durations = all<{ kind: string; s: number }>(
      `SELECT kind, ${secs} AS s FROM runs WHERE started_at >= ? AND started_at < ? AND finished_at IS NOT NULL AND status != 'running' ORDER BY s`, from, to);
    const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))] : null);
    const timing = (kind: string) => {
      const xs = durations.filter(d => d.kind === kind).map(d => d.s);
      return { count: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs.at(-1) ?? null };
    };
    const projects = all<{ project: string; repo: string; runs: number; applies: number; failed: number; destroys: number }>(
      `SELECT project, repo, count(*) AS runs, sum(kind = 'apply') AS applies, sum(status = 'failed') AS failed, sum(kind = 'plan' AND destroys > 0) AS destroys
       FROM runs WHERE started_at >= ? AND started_at < ? GROUP BY repo, project ORDER BY runs DESC LIMIT 10`, from, to);
    const people = all<{ user: string; runs: number; plans: number; applies: number; failed: number }>(
      `SELECT user, count(*) AS runs, sum(kind = 'plan') AS plans, sum(kind = 'apply') AS applies, sum(status = 'failed') AS failed
       FROM runs WHERE started_at >= ? AND started_at < ? GROUP BY user ORDER BY runs DESC LIMIT 10`, from, to);
    const engines = all<{ engine: string; n: number }>(
      `SELECT engine, count(*) AS n FROM runs WHERE started_at >= ? AND started_at < ? AND engine != '' GROUP BY engine ORDER BY n DESC LIMIT 8`, from, to);
    // Resources changed by applies, saved when each apply finished.
    const one = <T>(sql: string, ...args: (string | number)[]) => this.db.prepare(sql).get(...args) as T;
    const sums = one<{ added: number | null; changed: number | null; destroyed: number | null }>(
      `SELECT sum(json_extract(applied, '$.added')) AS added, sum(json_extract(applied, '$.changed')) AS changed, sum(json_extract(applied, '$.destroyed')) AS destroyed
       FROM runs WHERE kind = 'apply' AND applied IS NOT NULL AND started_at >= ? AND started_at < ?`, from, to);
    const resources = { added: sums.added ?? 0, changed: sums.changed ?? 0, destroyed: sums.destroyed ?? 0 };
    // Resource usage of runs: percentiles, and the heaviest runs.
    const mem = all<{ v: number }>(`SELECT json_extract(usage, '$.peakMemory') AS v FROM runs WHERE usage IS NOT NULL AND json_extract(usage, '$.quick') IS NULL AND started_at >= ? AND started_at < ? ORDER BY v`, from, to).map(x => x.v);
    const cpu = all<{ v: number }>(`SELECT json_extract(usage, '$.cpuSeconds') AS v FROM runs WHERE usage IS NOT NULL AND json_extract(usage, '$.quick') IS NULL AND started_at >= ? AND started_at < ? ORDER BY v`, from, to).map(x => x.v);
    const heaviest = all<{ id: number; repo: string; pr: number; project: string; kind: string; status: string; user: string; started_at: string; secs: number | null; usage: string }>(
      `SELECT id, repo, pr, project, kind, status, user, started_at, ${secs} AS secs, usage FROM runs
       WHERE usage IS NOT NULL AND json_extract(usage, '$.quick') IS NULL AND started_at >= ? AND started_at < ? ORDER BY json_extract(usage, '$.peakMemory') DESC LIMIT 10`, from, to)
      .map(r => ({ id: r.id, repo: r.repo, pr: r.pr, project: r.project, kind: r.kind, status: r.status, user: r.user, startedAt: r.started_at, seconds: r.secs, usage: JSON.parse(r.usage) }));
    const usage = {
      runs: mem.length,
      memory: { p50: pct(mem, 0.5), p95: pct(mem, 0.95), max: mem.at(-1) ?? null },
      cpu: { p50: pct(cpu, 0.5), p95: pct(cpu, 0.95), max: cpu.at(-1) ?? null, total: Math.round(cpu.reduce((a, b) => a + b, 0)) },
      heaviest,
    };
    const totals = one<{ runs: number; plans: number; applies: number; failed: number; prs: number; users: number; projects: number; repos: number; destroying: number }>(
      `SELECT count(*) AS runs, sum(kind = 'plan') AS plans, sum(kind = 'apply') AS applies, sum(status = 'failed') AS failed,
        count(DISTINCT repo || '#' || pr) AS prs, count(DISTINCT user) AS users, count(DISTINCT repo || '/' || project) AS projects,
        count(DISTINCT repo) AS repos, sum(kind = 'plan' AND destroys > 0) AS destroying
       FROM runs WHERE started_at >= ? AND started_at < ?`, from, to);
    return {
      from,
      totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v ?? 0])),
      daily, timing: { plan: timing('plan'), apply: timing('apply') },
      projects, people, engines, resources, usage,
      policy: {
        bySeverity: all<{ severity: string; n: number }>(`SELECT severity, count(*) AS n FROM policy_findings WHERE at >= ? AND at < ? GROUP BY severity`, from, to),
        topRules: all<{ rule: string; n: number; enforced: number }>(`SELECT rule, count(*) AS n, sum(mode = 'enforce') AS enforced FROM policy_findings WHERE at >= ? AND at < ? GROUP BY rule ORDER BY n DESC LIMIT 8`, from, to),
      },
      decisions: {
        total: one<{ n: number }>(`SELECT count(*) AS n FROM audit WHERE at >= ? AND at < ?`, from, to).n,
        denied: all<{ action: string; n: number }>(`SELECT action, count(*) AS n FROM audit WHERE at >= ? AND at < ? AND allowed = 0 GROUP BY action ORDER BY n DESC LIMIT 8`, from, to),
      },
      drift: all<{ status: string; n: number }>(`SELECT status, count(*) AS n FROM drift_runs WHERE at >= ? AND at < ? GROUP BY status`, from, to),
      locks: one<{ n: number; oldest: string | null }>(`SELECT count(*) AS n, min(created_at) AS oldest FROM locks`),
    };
  }

  // Newest successful apply of a project from any PR.
  lastApply(repo: string, project: string): Run | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE repo = ? AND project = ? AND kind = 'apply' AND status = 'success' ORDER BY id DESC LIMIT 1`).get(repo, project);
    return r ? toRun(r) : null;
  }

  // Filtered, sorted, paged runs for the dashboard. Output is left out of lists.
  searchRuns(q: RunQuery): { total: number; items: Run[] } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.q) {
      where.push(`(project LIKE ? ESCAPE '\\' OR repo LIKE ? ESCAPE '\\' OR user LIKE ? ESCAPE '\\' OR pr_author LIKE ? ESCAPE '\\' OR CAST(pr AS TEXT) = ?)`);
      const p = like(q.q.replace(/^#/, ''));
      args.push(p, p, p, p, q.q.replace(/^#/, ''));
    }
    if (q.user) { where.push('(user = ? OR pr_author = ?)'); args.push(q.user, q.user); }
    if (q.project) { where.push('project = ?'); args.push(q.project); }
    if (q.repo) { where.push('repo = ?'); args.push(q.repo); }
    if (q.kind) { where.push('kind = ?'); args.push(q.kind); }
    switch (q.status) {
      case 'failed': where.push(`status = 'failed'`); break;
      case 'running': where.push(`status IN ('running', 'queued')`); break;
      case 'applied': where.push(`kind = 'apply' AND status = 'success'`); break;
      case 'destroys': where.push(`kind = 'plan' AND status = 'success' AND destroys > 0`); break;
      case 'changes': where.push(`kind = 'plan' AND status = 'success' AND has_changes = 1`); break;
      case 'nochanges': where.push(`kind = 'plan' AND status = 'success' AND has_changes = 0`); break;
    }
    if (q.from) { where.push('started_at >= ?'); args.push(q.from); }
    if (q.to) { where.push('started_at < ?'); args.push(q.to); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const size = `(COALESCE(json_extract(summary, '$.add'), 0) + COALESCE(json_extract(summary, '$.change'), 0) + COALESCE(json_extract(summary, '$.destroy'), 0) + COALESCE(json_extract(summary, '$.replace'), 0))`;
    const order = {
      newest: 'id DESC', oldest: 'id ASC', project: 'project ASC, id DESC', user: 'user ASC, id DESC', changes: `${size} DESC, id DESC`,
    }[q.sort ?? 'newest'] ?? 'id DESC';
    const limit = Math.min(200, Math.max(1, q.limit ?? 50));
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM runs ${w}`).get(...args) as { n: number }).n);
    const items = this.db.prepare(`SELECT * FROM runs ${w} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, limit, Math.max(0, q.offset ?? 0)).map(toRun).map(r => ({ ...r, output: '' }));
    return { total, items };
  }

  // Values for the dashboard's filter dropdowns.
  facets(): { users: string[]; projects: string[]; repos: string[]; actions: string[] } {
    const col = (sql: string) => this.db.prepare(sql).all().map((r: Record<string, any>) => String(r.v)).filter(Boolean);
    return {
      users: col(`SELECT DISTINCT v FROM (SELECT user AS v FROM runs UNION SELECT pr_author FROM runs UNION SELECT user FROM audit) ORDER BY lower(v)`),
      projects: col('SELECT DISTINCT project AS v FROM runs ORDER BY v'),
      repos: col('SELECT DISTINCT repo AS v FROM runs ORDER BY v'),
      actions: col('SELECT DISTINCT action AS v FROM audit ORDER BY v'),
    };
  }

  // One row per project: latest run, latest successful apply, lock.
  projectSummaries(): ProjectSummary[] {
    const latest = this.db.prepare(`SELECT * FROM runs WHERE id IN (SELECT MAX(id) FROM runs GROUP BY repo, project, workspace) ORDER BY repo, project`).all().map(toRun);
    const counts = new Map(this.db.prepare('SELECT repo, project, workspace, COUNT(*) AS n FROM runs GROUP BY repo, project, workspace').all()
      .map((r: Record<string, any>) => [`${r.repo}|${r.project}|${r.workspace}`, Number(r.n)]));
    const applies = new Map(this.db.prepare(`SELECT * FROM runs WHERE id IN (SELECT MAX(id) FROM runs WHERE kind = 'apply' AND status = 'success' GROUP BY repo, project, workspace)`).all().map(toRun)
      .map(r => [`${r.repo}|${r.project}|${r.workspace}`, r]));
    return latest.map(r => {
      const k = `${r.repo}|${r.project}|${r.workspace}`;
      return { repo: r.repo, project: r.project, workspace: r.workspace, runs: counts.get(k) ?? 0, lastRun: { ...r, output: '' }, lastApply: applies.get(k) ?? null, lock: this.getLock(r.repo, r.project, r.workspace) };
    });
  }

  // The PR comment teriac keeps updating (single-comment mode).
  // Every comment teriac writes, as written, so tampering can be spotted and undone.
  rememberBotComment(repo: string, pr: number, id: string, body: string): void {
    this.db.prepare('INSERT INTO bot_comments (repo, comment_id, pr, body, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (repo, comment_id) DO UPDATE SET body = excluded.body, at = excluded.at')
      .run(repo, id, pr, body, now());
  }

  botComment(repo: string, id: string): { pr: number; body: string } | null {
    const r = this.db.prepare('SELECT pr, body FROM bot_comments WHERE repo = ? AND comment_id = ?').get(repo, id) as any;
    return r ? { pr: r.pr, body: r.body } : null;
  }

  commentId(repo: string, pr: number, kind = 'summary'): string | null {
    const r = this.db.prepare('SELECT comment_id FROM pr_comments WHERE repo = ? AND pr = ? AND kind = ?').get(repo, pr, kind);
    return r ? String(r.comment_id) : null;
  }

  saveCommentId(repo: string, pr: number, id: string, kind = 'summary'): void {
    this.db.prepare('INSERT INTO pr_comments (repo, pr, kind, comment_id) VALUES (?, ?, ?, ?) ON CONFLICT (repo, pr, kind) DO UPDATE SET comment_id = excluded.comment_id')
      .run(repo, pr, kind, id);
  }

  // ---- drift ----

  // True for exactly one caller per schedule and minute, even across restarts.
  claimDrift(scheduleKey: string, minute: string): boolean {
    const res = this.db.prepare('INSERT OR IGNORE INTO drift_claims (schedule_key, minute) VALUES (?, ?)').run(scheduleKey, minute);
    return Number(res.changes) === 1;
  }

  lastDriftFingerprint(scheduleKey: string, project: string): string | null {
    const r = this.db.prepare('SELECT fingerprint FROM drift_runs WHERE schedule_key = ? AND project = ? ORDER BY id DESC LIMIT 1').get(scheduleKey, project);
    return r ? String(r.fingerprint) : null;
  }

  saveDrift(d: { scheduleKey: string; repo: string; branch: string; sha: string; project: string; status: 'clean' | 'drift' | 'error'; fingerprint: string; finding: string }): number {
    const res = this.db.prepare(
      'INSERT INTO drift_runs (schedule_key, repo, branch, sha, project, status, fingerprint, finding, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(d.scheduleKey, d.repo, d.branch, d.sha, d.project, d.status, d.fingerprint, d.finding, now());
    return Number(res.lastInsertRowid);
  }

  markNotified(ids: number[], result: string): void {
    const stmt = this.db.prepare('UPDATE drift_runs SET notified = ? WHERE id = ?');
    for (const id of ids) stmt.run(result, id);
  }

  recentDrift(limit = 100): Record<string, unknown>[] {
    return this.db.prepare('SELECT * FROM drift_runs ORDER BY id DESC LIMIT ?').all(limit).map((r: Record<string, any>) => ({
      ...r, finding: JSON.parse(r.finding), notified: r.notified ? JSON.parse(r.notified) : null,
    }));
  }

  // ---- audit ----

  audit(e: Omit<AuditEntry, 'at'>): void {
    this.db.prepare('INSERT INTO audit (at, repo, pr, user, action, project, allowed, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now(), e.repo, e.pr, e.user, e.action, e.project, e.allowed ? 1 : 0, e.reason);
  }

  searchAudit(q: AuditQuery): { total: number; items: AuditEntry[] } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.q) {
      where.push(`(user LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\' OR repo LIKE ? ESCAPE '\\')`);
      const p = like(q.q);
      args.push(p, p, p, p);
    }
    if (q.user) { where.push('user = ?'); args.push(q.user); }
    if (q.project) { where.push('project = ?'); args.push(q.project); }
    if (q.action) { where.push('action = ?'); args.push(q.action); }
    if (q.allowed !== undefined) { where.push('allowed = ?'); args.push(q.allowed ? 1 : 0); }
    if (q.from) { where.push('at >= ?'); args.push(q.from); }
    if (q.to) { where.push('at < ?'); args.push(q.to); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM audit ${w}`).get(...args) as { n: number }).n);
    const items = this.db.prepare(`SELECT * FROM audit ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(500, Math.max(1, q.limit ?? 100)), Math.max(0, q.offset ?? 0))
      .map((r: Record<string, any>) => ({ at: r.at, repo: r.repo, pr: r.pr, user: r.user, action: r.action, project: r.project, allowed: !!r.allowed, reason: r.reason }));
    return { total, items };
  }

  auditLog(limit = 100): AuditEntry[] {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit).map((r: Record<string, any>) => ({
      at: r.at, repo: r.repo, pr: r.pr, user: r.user, action: r.action, project: r.project, allowed: !!r.allowed, reason: r.reason,
    }));
  }
}
