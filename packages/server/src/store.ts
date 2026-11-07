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
}

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

  finishRun(id: number, r: { status: RunStatus; engine?: string; summary?: string | null; output: string; planPath?: string | null; hasChanges?: boolean; destroys?: number }): void {
    this.db.prepare(
      'UPDATE runs SET status = ?, finished_at = ?, engine = ?, summary = ?, output = ?, plan_path = ?, has_changes = ?, destroys = ? WHERE id = ?',
    ).run(r.status, now(), r.engine ?? '', r.summary ?? null, r.output, r.planPath ?? null, r.hasChanges ? 1 : 0, r.destroys ?? 0, id);
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
  discardPlans(repo: string, pr: number): void {
    this.db.prepare(`UPDATE runs SET plan_path = NULL WHERE repo = ? AND pr = ? AND kind = 'plan'`).run(repo, pr);
  }

  // Newest successful apply of a project from any PR.
  lastApply(repo: string, project: string): Run | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE repo = ? AND project = ? AND kind = 'apply' AND status = 'success' ORDER BY id DESC LIMIT 1`).get(repo, project);
    return r ? toRun(r) : null;
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

  auditLog(limit = 100): AuditEntry[] {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit).map((r: Record<string, any>) => ({
      at: r.at, repo: r.repo, pr: r.pr, user: r.user, action: r.action, project: r.project, allowed: !!r.allowed, reason: r.reason,
    }));
  }
}
