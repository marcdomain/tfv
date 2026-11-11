// Scheduled database backups.
//
// At each scheduled minute the server copies the database with SQLite's VACUUM INTO (a
// complete, readable copy even while runs are writing), gzips it, uploads it with rclone and
// deletes the local copy. Nothing is kept on the volume. teriac never deletes backups: old
// ones are removed by the bucket's lifecycle rule. Every backup is a whole database on its
// own, so expiring old ones never affects newer ones.
//
// On start, when the volume has no database, the newest backup that passes an integrity
// check is restored. If it can't be read (expired between listing and download, or broken),
// the next newest is tried.
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { parseCron, cronMatches, nextRun } from './cron.ts';
import { log, addSecret } from './log.ts';
import type { ChannelConfig, Person } from './config.ts';

export type BackupBackend = 's3' | 'gcs' | 'azure';
export interface BackupConfig {
  schedule: string;
  timezone: string;
  backend: BackupBackend;
  bucket: string;
  path: string;
  s3: { region?: string; endpoint?: string; storageClass?: string };
  azure: { account?: string; key?: string };
  notify: string[];
}

const BACKENDS: BackupBackend[] = ['s3', 'gcs', 'azure'];
// teriac-20261111T030000123Z.db.gz: UTC to the millisecond, sorts by time as text.
const NAME = /^teriac-\d{8}T\d{6}(\d{3})?Z\.db\.gz$/;
const RESTORE_TRIES = 5;
const RCLONE_TIMEOUT_MS = 30 * 60_000;

// Reads TERIAC_BACKUP_* settings. Off unless TERIAC_BACKUP_ENABLED=true; then every
// mistake is one clear error at start-up instead of a failed backup at 3am.
export const parseBackup = (env: NodeJS.ProcessEnv, channels: Record<string, unknown> = {}): BackupConfig | undefined => {
  const on = (env.TERIAC_BACKUP_ENABLED ?? '').trim().toLowerCase();
  if (on !== 'true') {
    if (on && on !== 'false') throw new Error(`TERIAC_BACKUP_ENABLED must be true or false, not "${env.TERIAC_BACKUP_ENABLED}"`);
    return undefined;
  }
  const need = (name: string) => {
    const v = (env[name] ?? '').trim();
    if (!v) throw new Error(`${name} is required when TERIAC_BACKUP_ENABLED=true`);
    return v;
  };
  const schedule = need('TERIAC_BACKUP_SCHEDULE');
  try { parseCron(schedule); } catch (err) {
    throw new Error(`TERIAC_BACKUP_SCHEDULE "${schedule}" is not a cron expression (minute hour day month weekday, e.g. "0 3 * * *"): ${(err as Error).message}`);
  }
  const timezone = (env.TERIAC_BACKUP_TIMEZONE ?? '').trim() || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch {
    throw new Error(`TERIAC_BACKUP_TIMEZONE "${timezone}" is not a time zone (e.g. UTC, Europe/Madrid)`);
  }
  const backend = need('TERIAC_BACKUP_BACKEND').toLowerCase() as BackupBackend;
  if (!BACKENDS.includes(backend)) throw new Error(`TERIAC_BACKUP_BACKEND must be s3, gcs or azure, not "${backend}"`);
  const bucket = need('TERIAC_BACKUP_BUCKET');
  if (bucket.includes('/') || /\s/.test(bucket)) {
    throw new Error(`TERIAC_BACKUP_BUCKET "${bucket}" must be only the bucket${backend === 'azure' ? ' (container)' : ''} name; put folders in TERIAC_BACKUP_PATH`);
  }
  const path = (env.TERIAC_BACKUP_PATH ?? '').trim().replace(/^\/+|\/+$/g, '') || 'teriac';
  if (path.split('/').some(p => p === '..' || p === '.' || p === '') || !/^[A-Za-z0-9._\-/]+$/.test(path)) {
    throw new Error(`TERIAC_BACKUP_PATH "${env.TERIAC_BACKUP_PATH}" may use letters, digits, ".", "_", "-" and "/" between folder names, and no "..": e.g. teriac/prod`);
  }
  const endpoint = (env.TERIAC_BACKUP_S3_ENDPOINT ?? '').trim();
  if (endpoint && !/^https?:\/\/[^\s/]+/.test(endpoint)) throw new Error(`TERIAC_BACKUP_S3_ENDPOINT must be a URL like https://minio.acme.dev, not "${endpoint}"`);
  const account = (env.TERIAC_BACKUP_AZURE_ACCOUNT ?? '').trim();
  if (backend === 'azure' && !account) throw new Error('TERIAC_BACKUP_AZURE_ACCOUNT (the storage account name) is required for the azure backend');
  const notify = (env.TERIAC_BACKUP_NOTIFY ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const n of notify) if (!channels[n]) throw new Error(`TERIAC_BACKUP_NOTIFY: no channel named "${n}" in repos.yaml`);
  return {
    schedule, timezone, backend, bucket, path, notify,
    s3: { region: env.TERIAC_BACKUP_S3_REGION?.trim() || undefined, endpoint: endpoint || undefined, storageClass: env.TERIAC_BACKUP_S3_STORAGE_CLASS?.trim() || undefined },
    azure: { account: account || undefined, key: env.TERIAC_BACKUP_AZURE_KEY?.trim() || undefined },
  };
};

// Where backups go, for logs and the dashboard.
export const destination = (c: BackupConfig) => `${c.backend === 'gcs' ? 'gs' : c.backend === 'azure' ? `azure://${c.azure.account}` : 's3'}${c.backend === 'azure' ? '/' : '://'}${c.bucket}/${c.path}`;

export const backupName = (at: Date) => `teriac-${at.toISOString().replace(/[-:.]/g, '')}.db.gz`;

// The bucket, through rclone. The remote is defined in env vars, so no config file is written.
// Credentials come from the usual places: AWS_* env vars, IRSA or EKS Pod Identity;
// GOOGLE_APPLICATION_CREDENTIALS or GKE Workload Identity; an Azure key, or a managed identity.
export interface Remote {
  list(): Promise<string[]>;
  put(file: string, name: string): Promise<void>;
  get(name: string, file: string): Promise<void>;
}

export const rcloneEnv = (c: BackupConfig): Record<string, string> => {
  const e: Record<string, string> = { RCLONE_CONFIG: '/dev/null' };
  const set = (k: string, v: string | undefined) => { if (v) e[`RCLONE_CONFIG_TERIAC_${k}`] = v; };
  if (c.backend === 's3') {
    set('TYPE', 's3');
    set('PROVIDER', c.s3.endpoint ? 'Other' : 'AWS');
    set('ENV_AUTH', 'true');
    set('REGION', c.s3.region);
    set('ENDPOINT', c.s3.endpoint);
    set('STORAGE_CLASS', c.s3.storageClass);
    // Works with "bucket owner enforced" buckets (ACLs disabled), the AWS default.
    if (!c.s3.endpoint) set('ACL', 'bucket-owner-full-control');
    set('NO_CHECK_BUCKET', 'true'); // no CreateBucket permission needed
  } else if (c.backend === 'gcs') {
    set('TYPE', 'google cloud storage');
    set('ENV_AUTH', 'true');
    set('BUCKET_POLICY_ONLY', 'true'); // uniform bucket-level access
    set('NO_CHECK_BUCKET', 'true');
  } else {
    set('TYPE', 'azureblob');
    set('ACCOUNT', c.azure.account);
    if (c.azure.key) set('KEY', c.azure.key); else set('ENV_AUTH', 'true');
    set('NO_CHECK_CONTAINER', 'true');
  }
  return e;
};

// The part of rclone's output that says what went wrong: the storage service's own error
// ("AccessDenied: …", "NoSuchBucket: …") when there is one, else rclone's last line.
export const rcloneError = (stderr: string) => {
  const api = /api error (\w+): ([^\n]*?)(?=\s*(?:·|$|\n))/m.exec(stderr);
  if (api) return `${api[1]}: ${api[2]}`;
  const lines = stderr.split('\n')
    .map(l => l.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, '').replace(/^(ERROR|NOTICE|CRITICAL)\s*:\s*/, '').trim())
    .filter(Boolean);
  return lines.at(-1) ?? '';
};

export const rcloneRemote = (c: BackupConfig, bin = process.env.TERIAC_RCLONE_BIN || 'rclone'): Remote => {
  addSecret(c.azure.key);
  const base = `teriac:${c.bucket}/${c.path}`;
  const run = (args: string[]) => new Promise<string>((resolve, reject) => {
    const child = spawn(bin, [...args, '--retries', '3', '--low-level-retries', '10', '--stats', '0'], {
      env: { ...process.env, ...rcloneEnv(c) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), RCLONE_TIMEOUT_MS);
    child.on('error', e => {
      clearTimeout(timer);
      reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? `rclone is not installed (looked for "${bin}")` : e.message));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      reject(new Error(rcloneError(err) || `rclone exited with ${code}`));
    });
  });
  return {
    list: async () => (await run(['lsf', '--files-only', base])).split('\n').map(s => s.trim()).filter(Boolean),
    put: async (file, name) => { await run(['copyto', file, `${base}/${name}`]); },
    get: async (name, file) => { await run(['copyto', `${base}/${name}`, file]); },
  };
};

const removeQuietly = (...files: string[]) => { for (const f of files) rmSync(f, { force: true }); };

// Leftovers from a backup or restore that a crash interrupted. Run on every start.
export const cleanLeftovers = (dataDir: string) => {
  if (!existsSync(dataDir)) return;
  for (const f of readdirSync(dataDir)) {
    if (/^\.(backup|restore)-/.test(f)) removeQuietly(join(dataDir, f));
  }
};

// A restored file is used only if SQLite says it's whole and it is a teriac database.
const usable = (file: string) => {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const check = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (check.integrity_check !== 'ok') return `integrity check failed: ${check.integrity_check}`;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get()) return 'not a teriac database';
    return null;
  } catch (err) {
    return (err as Error).message;
  } finally {
    db?.close();
  }
};

export interface RestoreResult { restored: string | null; skipped: { name: string; reason: string }[] }

// Restores the newest usable backup into `dbPath`, which must not exist. Throws when the
// bucket can't be listed or no backup can be read, so the server never starts empty by
// mistake; starts empty (restored: null) only when the bucket has no backups at all.
export const restoreLatest = async (remote: Remote, dbPath: string, where: string): Promise<RestoreResult> => {
  if (existsSync(dbPath)) throw new Error(`refusing to restore over ${dbPath}`);
  let names: string[];
  try {
    names = (await remote.list()).filter(n => NAME.test(n)).sort().reverse();
  } catch (err) {
    throw new Error(`cannot list backups at ${where}: ${(err as Error).message}. Fix the backup settings, or set TERIAC_BACKUP_ENABLED=false to start without restoring`);
  }
  if (!names.length) return { restored: null, skipped: [] };
  const dir = join(dbPath, '..');
  const gz = join(dir, '.restore-download.db.gz');
  const tmp = join(dir, '.restore-download.db');
  const skipped: RestoreResult['skipped'] = [];
  for (const name of names.slice(0, RESTORE_TRIES)) {
    try {
      removeQuietly(gz, tmp);
      await remote.get(name, gz);
      await pipeline(createReadStream(gz), createGunzip(), createWriteStream(tmp));
      const problem = usable(tmp);
      if (problem) throw new Error(problem);
      // A WAL left by a lost database belongs to it, not to the restored one.
      removeQuietly(`${dbPath}-wal`, `${dbPath}-shm`);
      renameSync(tmp, dbPath);
      return { restored: name, skipped };
    } catch (err) {
      // Expired or deleted after listing, cut short, or not a database: try the next newest.
      skipped.push({ name, reason: (err as Error).message });
      log.warn('backup could not be restored; trying an older one', { name, err: (err as Error).message });
    } finally {
      removeQuietly(gz, tmp);
    }
  }
  throw new Error(`none of the ${skipped.length} newest backups at ${where} could be restored: ${skipped.map(s => `${s.name} (${s.reason})`).join('; ')}`);
};

export interface BackupRun {
  id: number; at: string; trigger: 'schedule' | 'manual'; ok: boolean;
  name: string | null; bytes: number | null; seconds: number; error: string | null;
}

export interface BackupStore {
  backupTo(file: string): void;
  claimDrift(scheduleKey: string, minute: string): boolean;
  recordBackup(r: Omit<BackupRun, 'id'>): BackupRun;
  recentBackups(limit: number): BackupRun[];
}

export interface BackupDeps {
  cfg: BackupConfig;
  store: BackupStore;
  remote: Remote;
  dataDir: string;
  notify?: (title: string, lines: string[], ok: boolean) => Promise<unknown>;
}

export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<BackupRun> | null = null;
  private d: BackupDeps;
  constructor(d: BackupDeps) { this.d = d; }

  start() {
    const tick = () => {
      void this.tick(new Date());
      this.timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
      this.timer.unref?.();
    };
    tick();
  }
  stop() { if (this.timer) clearTimeout(this.timer); }
  // Waits for a backup that is uploading, so shutdown doesn't cut it off.
  async idle() { await this.running?.catch(() => undefined); }
  get busy() { return this.running !== null; }

  next(now = new Date()) {
    return nextRun(parseCron(this.d.cfg.schedule), now, this.d.cfg.timezone)?.toISOString() ?? null;
  }

  async tick(now: Date) {
    const c = this.d.cfg;
    if (!cronMatches(parseCron(c.schedule), now, c.timezone)) return null;
    if (!this.d.store.claimDrift(`backup:${c.schedule}`, now.toISOString().slice(0, 16))) return null;
    return this.run('schedule', now);
  }

  // One backup at a time: a second request while one runs gets the running one.
  run(trigger: BackupRun['trigger'], now = new Date()): Promise<BackupRun> {
    if (this.running) return this.running;
    this.running = this.backup(trigger, now).finally(() => { this.running = null; });
    return this.running;
  }

  private async backup(trigger: BackupRun['trigger'], now: Date): Promise<BackupRun> {
    const started = Date.now();
    const before = this.d.store.recentBackups(1)[0];
    // Never reuse a name: a scheduled and a manual backup can start in the same millisecond.
    let at = now;
    if (before?.name && before.name >= backupName(at)) at = new Date(Date.parse(before.at) + 1);
    const name = backupName(at);
    const tmp = join(this.d.dataDir, `.backup-${process.pid}.db`);
    const gz = `${tmp}.gz`;
    let result: Omit<BackupRun, 'id'>;
    try {
      removeQuietly(tmp, gz);
      this.d.store.backupTo(tmp);
      await pipeline(createReadStream(tmp), createGzip({ level: 6 }), createWriteStream(gz));
      removeQuietly(tmp);
      const bytes = statSync(gz).size;
      await this.d.remote.put(gz, name);
      result = { at: at.toISOString(), trigger, ok: true, name, bytes, seconds: (Date.now() - started) / 1000, error: null };
      log.info('backup uploaded', { name, bytes, to: destination(this.d.cfg) });
    } catch (err) {
      result = { at: at.toISOString(), trigger, ok: false, name: null, bytes: null, seconds: (Date.now() - started) / 1000, error: (err as Error).message };
      log.error('backup failed', { err: (err as Error).message, to: destination(this.d.cfg) });
    } finally {
      // Nothing is kept on the volume, whether the upload worked or not.
      removeQuietly(tmp, gz);
    }
    const saved = this.d.store.recordBackup(result);
    // Chat: every failure, and the first success after one.
    if (this.d.notify && (!saved.ok || (before && !before.ok))) {
      const title = saved.ok ? '✅ teriac backups are working again' : '❌ teriac backup failed';
      const lines = saved.ok ? [`Uploaded \`${saved.name}\` to ${destination(this.d.cfg)}`] : [`To ${destination(this.d.cfg)}: ${saved.error}`, `Next try: ${this.next() ?? 'unknown'}`];
      this.d.notify(title, lines, saved.ok).catch(err => log.warn('backup notice failed', { err: (err as Error).message }));
    }
    return saved;
  }
}
