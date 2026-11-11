// Scheduled backups: settings, the copy-upload-delete cycle, and restoring an empty volume.
// The bucket is a folder here; the Docker end-to-end test uses real rclone and an S3 server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BackupScheduler, backupName, rcloneError, cleanLeftovers, destination, parseBackup, rcloneEnv, restoreLatest, type Remote } from '../src/backup.ts';
import { Store } from '../src/store.ts';

const base = {
  TERIAC_BACKUP_ENABLED: 'true', TERIAC_BACKUP_SCHEDULE: '0 3 * * *', TERIAC_BACKUP_BACKEND: 's3', TERIAC_BACKUP_BUCKET: 'acme-backups',
};
const fails = (env: Record<string, string>, pattern: RegExp) => assert.throws(() => parseBackup({ ...base, ...env }, { ops: {} }), pattern);

test('settings: off by default; every mistake is one clear error', () => {
  assert.equal(parseBackup({}), undefined);
  assert.equal(parseBackup({ TERIAC_BACKUP_ENABLED: 'false', TERIAC_BACKUP_BACKEND: 's3' }), undefined, 'other settings are ignored while off');
  const c = parseBackup(base)!;
  assert.deepEqual([c.schedule, c.timezone, c.backend, c.bucket, c.path], ['0 3 * * *', 'UTC', 's3', 'acme-backups', 'teriac']);
  assert.equal(destination(c), 's3://acme-backups/teriac');
  assert.equal(parseBackup({ ...base, TERIAC_BACKUP_PATH: '/teriac/prod/' })!.path, 'teriac/prod', 'slashes trimmed');
  fails({ TERIAC_BACKUP_ENABLED: 'yes' }, /must be true or false/);
  fails({ TERIAC_BACKUP_SCHEDULE: '' }, /TERIAC_BACKUP_SCHEDULE is required/);
  fails({ TERIAC_BACKUP_SCHEDULE: '24h' }, /not a cron expression/);
  fails({ TERIAC_BACKUP_SCHEDULE: '0 25 * * *' }, /not a cron expression/);
  fails({ TERIAC_BACKUP_TIMEZONE: 'Mars/Base' }, /not a time zone/);
  fails({ TERIAC_BACKUP_BACKEND: 'dropbox' }, /must be s3, gcs or azure/);
  fails({ TERIAC_BACKUP_BUCKET: '' }, /TERIAC_BACKUP_BUCKET is required/);
  fails({ TERIAC_BACKUP_BUCKET: 'acme/teriac' }, /only the bucket name; put folders in TERIAC_BACKUP_PATH/);
  fails({ TERIAC_BACKUP_PATH: 'teriac/../other' }, /no "\.\."/);
  fails({ TERIAC_BACKUP_PATH: 'teriac//prod' }, /between folder names/);
  fails({ TERIAC_BACKUP_S3_ENDPOINT: 'minio:9000' }, /must be a URL/);
  fails({ TERIAC_BACKUP_BACKEND: 'azure' }, /TERIAC_BACKUP_AZURE_ACCOUNT/);
  fails({ TERIAC_BACKUP_NOTIFY: 'ops,nope' }, /no channel named "nope"/);
  assert.equal(destination(parseBackup({ ...base, TERIAC_BACKUP_BACKEND: 'azure', TERIAC_BACKUP_AZURE_ACCOUNT: 'acmestore' })!), 'azure://acmestore/acme-backups/teriac');
  assert.equal(destination(parseBackup({ ...base, TERIAC_BACKUP_BACKEND: 'GCS' })!), 'gs://acme-backups/teriac', 'backend is case-insensitive');
});

test('rclone settings per backend: no bucket creation, keyless sign-in by default', () => {
  const s3 = rcloneEnv(parseBackup({ ...base, TERIAC_BACKUP_S3_REGION: 'eu-west-1' })!);
  assert.equal(s3.RCLONE_CONFIG_TERIAC_PROVIDER, 'AWS');
  assert.equal(s3.RCLONE_CONFIG_TERIAC_ENV_AUTH, 'true');
  assert.equal(s3.RCLONE_CONFIG_TERIAC_ACL, 'bucket-owner-full-control');
  assert.equal(s3.RCLONE_CONFIG_TERIAC_NO_CHECK_BUCKET, 'true');
  const minio = rcloneEnv(parseBackup({ ...base, TERIAC_BACKUP_S3_ENDPOINT: 'http://minio:9000' })!);
  assert.deepEqual([minio.RCLONE_CONFIG_TERIAC_PROVIDER, minio.RCLONE_CONFIG_TERIAC_ENDPOINT, minio.RCLONE_CONFIG_TERIAC_ACL], ['Other', 'http://minio:9000', undefined]);
  const gcs = rcloneEnv(parseBackup({ ...base, TERIAC_BACKUP_BACKEND: 'gcs' })!);
  assert.deepEqual([gcs.RCLONE_CONFIG_TERIAC_TYPE, gcs.RCLONE_CONFIG_TERIAC_BUCKET_POLICY_ONLY], ['google cloud storage', 'true']);
  const azKey = rcloneEnv(parseBackup({ ...base, TERIAC_BACKUP_BACKEND: 'azure', TERIAC_BACKUP_AZURE_ACCOUNT: 'a', TERIAC_BACKUP_AZURE_KEY: 'k' })!);
  assert.deepEqual([azKey.RCLONE_CONFIG_TERIAC_KEY, azKey.RCLONE_CONFIG_TERIAC_ENV_AUTH], ['k', undefined]);
  const azId = rcloneEnv(parseBackup({ ...base, TERIAC_BACKUP_BACKEND: 'azure', TERIAC_BACKUP_AZURE_ACCOUNT: 'a' })!);
  assert.equal(azId.RCLONE_CONFIG_TERIAC_ENV_AUTH, 'true', 'managed or workload identity');
});

test('backup names are UTC and sort by time', () => {
  assert.equal(backupName(new Date('2026-11-11T03:00:00.123Z')), 'teriac-20261111T030000123Z.db.gz');
  assert.ok(backupName(new Date('2026-12-01T00:00:00Z')) > backupName(new Date('2026-11-30T23:59:59Z')));
});

// A folder that acts like a bucket. `expire` deletes objects, as a lifecycle rule would.
const folderRemote = (dir: string, opts: { failList?: string; failPut?: string; expireOnGet?: string[] } = {}): Remote & { names(): string[] } => ({
  names: () => readdirSync(dir).sort(),
  list: async () => { if (opts.failList) throw new Error(opts.failList); return readdirSync(dir); },
  put: async (file, name) => { if (opts.failPut) throw new Error(opts.failPut); copyFileSync(file, join(dir, name)); },
  get: async (name, file) => {
    if (opts.expireOnGet?.includes(name)) { rmSync(join(dir, name), { force: true }); throw new Error('object not found'); }
    copyFileSync(join(dir, name), file);
  },
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'teriac-backup-'));
  const data = join(root, 'data');
  const bucket = join(root, 'bucket');
  mkdirSync(data);
  mkdirSync(bucket);
  return { root, data, bucket };
};

test('a backup is copied, uploaded, recorded, and nothing stays on the volume', async () => {
  const { data, bucket } = setup();
  const store = new Store(join(data, 'teriac.db'));
  store.audit({ repo: 'r', pr: 1, user: 'ada', action: 'apply', project: 'p', allowed: true, reason: 'before backup' });
  const remote = folderRemote(bucket);
  const s = new BackupScheduler({ cfg: parseBackup(base)!, store, remote, dataDir: data });
  const at = new Date('2026-11-11T03:00:00Z');
  const r = await s.tick(at);
  assert.equal(r?.ok, true);
  assert.deepEqual(remote.names(), ['teriac-20261111T030000000Z.db.gz']);
  assert.ok(r!.bytes! > 0);
  assert.deepEqual(readdirSync(data).filter(f => !f.startsWith('teriac.db')), [], 'no copies left on the volume');
  assert.equal(await s.tick(at), null, 'each scheduled minute runs once');
  assert.equal(await s.tick(new Date('2026-11-11T03:01:00Z')), null, 'off-schedule minutes do nothing');
  assert.equal(store.recentBackups(5).length, 1);
  store.close();
});

test('a failed upload is recorded and notified, still leaves nothing behind, and recovery is announced', async () => {
  const { data, bucket } = setup();
  const store = new Store(join(data, 'teriac.db'));
  const notices: string[] = [];
  const failing = folderRemote(bucket, { failPut: 'AccessDenied: not allowed to write' });
  const cfg = parseBackup(base)!;
  const bad = new BackupScheduler({ cfg, store, remote: failing, dataDir: data, notify: async t => { notices.push(t); } });
  const r = await bad.run('manual', new Date('2026-11-11T03:00:00Z'));
  assert.equal(r.ok, false);
  assert.match(r.error!, /AccessDenied/);
  assert.deepEqual(readdirSync(data).filter(f => !f.startsWith('teriac.db')), []);
  const good = new BackupScheduler({ cfg, store, remote: folderRemote(bucket), dataDir: data, notify: async t => { notices.push(t); } });
  assert.equal((await good.run('manual', new Date('2026-11-11T04:00:00Z'))).ok, true);
  assert.equal((await good.run('manual', new Date('2026-11-11T05:00:00Z'))).ok, true);
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(notices, ['❌ teriac backup failed', '✅ teriac backups are working again'], 'quiet while healthy');
  store.close();
});

test('two backups in the same millisecond still get different names', async () => {
  const { data, bucket } = setup();
  const store = new Store(join(data, 'teriac.db'));
  const remote = folderRemote(bucket);
  const s = new BackupScheduler({ cfg: parseBackup(base)!, store, remote, dataDir: data });
  const at = new Date('2026-11-11T03:00:00Z');
  await s.run('schedule', at);
  await s.run('manual', at);
  assert.deepEqual(remote.names(), ['teriac-20261111T030000000Z.db.gz', 'teriac-20261111T030000001Z.db.gz']);
  store.close();
});

test('two requests at once share one backup', async () => {
  const { data, bucket } = setup();
  const store = new Store(join(data, 'teriac.db'));
  const s = new BackupScheduler({ cfg: parseBackup(base)!, store, remote: folderRemote(bucket), dataDir: data });
  const [a, b] = await Promise.all([s.run('manual'), s.run('manual')]);
  assert.equal(a.id, b.id);
  assert.equal(store.recentBackups(5).length, 1);
  store.close();
});

test('restore: newest usable backup; broken, expired or foreign ones are skipped', async () => {
  const { root, data, bucket } = setup();
  // Two real backups, an hour apart.
  const src = new Store(join(root, 'src.db'));
  const s = new BackupScheduler({ cfg: parseBackup(base)!, store: src, remote: folderRemote(bucket), dataDir: root });
  src.audit({ repo: 'r', pr: 1, user: 'ada', action: 'apply', project: 'p', allowed: true, reason: 'first' });
  await s.run('manual', new Date('2026-11-10T03:00:00Z'));
  src.audit({ repo: 'r', pr: 2, user: 'ada', action: 'apply', project: 'p', allowed: true, reason: 'second' });
  await s.run('manual', new Date('2026-11-11T03:00:00Z'));
  src.close();
  // Newer than both: a cut-short upload, a gzip of something that isn't a database, a foreign file.
  writeFileSync(join(bucket, 'teriac-20261112T030000Z.db.gz'), gzipSync(Buffer.from('not sqlite')));
  writeFileSync(join(bucket, 'teriac-20261113T030000Z.db.gz'), Buffer.from([0x1f, 0x8b, 0x08]));
  writeFileSync(join(bucket, 'notes.txt'), 'ignored');
  // A stale WAL from the lost database must not be applied to the restored one.
  writeFileSync(join(data, 'teriac.db-wal'), 'stale');

  const dbPath = join(data, 'teriac.db');
  const r = await restoreLatest(folderRemote(bucket), dbPath, 's3://test');
  assert.equal(r.restored, 'teriac-20261111T030000000Z.db.gz');
  assert.deepEqual(r.skipped.map(x => x.name), ['teriac-20261113T030000Z.db.gz', 'teriac-20261112T030000Z.db.gz']);
  assert.ok(!existsSync(join(data, 'teriac.db-wal')));
  const restored = new Store(dbPath);
  assert.deepEqual(restored.auditLog(5).map(a => a.reason).sort(), ['first', 'second']);
  restored.close();
  assert.deepEqual(readdirSync(data).filter(f => f.startsWith('.restore')), [], 'downloads cleaned up');
});

test('restore: a backup expired by the lifecycle rule after listing falls back to the next', async () => {
  const { root, data, bucket } = setup();
  const src = new Store(join(root, 'src.db'));
  const s = new BackupScheduler({ cfg: parseBackup(base)!, store: src, remote: folderRemote(bucket), dataDir: root });
  await s.run('manual', new Date('2026-11-10T03:00:00Z'));
  await s.run('manual', new Date('2026-11-11T03:00:00Z'));
  src.close();
  const r = await restoreLatest(folderRemote(bucket, { expireOnGet: ['teriac-20261111T030000000Z.db.gz'] }), join(data, 'teriac.db'), 's3://test');
  assert.equal(r.restored, 'teriac-20261110T030000000Z.db.gz');
});

test('restore: empty bucket starts empty; unreadable bucket or no usable backup refuses to start', async () => {
  const { data, bucket } = setup();
  const dbPath = join(data, 'teriac.db');
  assert.deepEqual(await restoreLatest(folderRemote(bucket), dbPath, 's3://test'), { restored: null, skipped: [] });
  await assert.rejects(restoreLatest(folderRemote(bucket, { failList: 'NoSuchBucket' }), dbPath, 's3://test'), /cannot list backups at s3:\/\/test: NoSuchBucket.*TERIAC_BACKUP_ENABLED=false/);
  writeFileSync(join(bucket, 'teriac-20261112T030000Z.db.gz'), gzipSync(Buffer.from('junk')));
  await assert.rejects(restoreLatest(folderRemote(bucket), dbPath, 's3://test'), /none of the 1 newest backups/);
  assert.ok(!existsSync(dbPath), 'never leaves a half-restored database');
  writeFileSync(dbPath, '');
  await assert.rejects(restoreLatest(folderRemote(bucket), dbPath, 's3://test'), /refusing to restore over/);
});

test('leftovers from an interrupted backup or restore are removed on start', () => {
  const { data } = setup();
  for (const f of ['.backup-123.db', '.backup-123.db.gz', '.restore-download.db.gz', 'teriac.db', 'keep.txt']) writeFileSync(join(data, f), 'x');
  cleanLeftovers(data);
  assert.deepEqual(readdirSync(data).sort(), ['keep.txt', 'teriac.db']);
});

test('dashboard: status, admins back up now (audited), viewers cannot, metrics', async () => {
  const { createHttpServer } = await import('../src/http.ts');
  const { hashPassword } = await import('../src/auth.ts');
  const { data, bucket } = setup();
  const store = new Store(join(data, 'teriac.db'));
  const cfg = parseBackup(base)!;
  const backups = new BackupScheduler({ cfg, store, remote: folderRemote(bucket), dataDir: data });
  const auth = {
    apiToken: 'api-token-for-tests-1234567890', sessionSecret: 's'.repeat(32), sessionHours: 1, secureCookies: false,
    users: [{ username: 'vic', password_hash: hashPassword('pw-vic-123'), role: 'viewer' as const }],
  };
  const srv = createHttpServer({ app: { runQueue: null } as any, store, adapters: {}, auth, ready: () => true, backups, config: { backup: cfg, repos: [] } as any });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
  const admin = { Authorization: `Bearer ${auth.apiToken}` };
  const login = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'teriac' }, body: JSON.stringify({ username: 'vic', password: 'pw-vic-123' }) });
  const vic = { Cookie: login.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), 'X-Requested-With': 'teriac' };

  const before = await (await fetch(`${url}/api/backups`, { headers: vic })).json();
  assert.deepEqual([before.enabled, before.destination, before.canRun, before.runs.length], [true, 's3://acme-backups/teriac', false, 0]);
  assert.match(before.next, /T03:00:00/);
  assert.equal((await fetch(`${url}/api/backups/run`, { method: 'POST', headers: vic })).status, 403);
  const res = await fetch(`${url}/api/backups/run`, { method: 'POST', headers: admin });
  assert.equal(res.status, 200);
  const run = await res.json();
  assert.equal(run.trigger, 'manual');
  assert.deepEqual(readdirSync(bucket), [run.name]);
  assert.ok(store.auditLog(5).some(a => a.action === 'backup' && a.allowed));
  const m = await (await fetch(`${url}/metrics`)).text();
  assert.match(m, /teriac_backup_last_ok 1/);
  assert.match(m, /teriac_backup_last_success_timestamp_seconds [1-9]\d+/);
  srv.close();

  const off = createHttpServer({ app: { runQueue: null } as any, store, adapters: {}, auth, ready: () => true });
  await new Promise<void>(r => off.listen(0, '127.0.0.1', () => r()));
  const offUrl = `http://127.0.0.1:${(off.address() as import('node:net').AddressInfo).port}`;
  assert.deepEqual(await (await fetch(`${offUrl}/api/backups`, { headers: admin })).json(), { enabled: false });
  assert.equal((await fetch(`${offUrl}/api/backups/run`, { method: 'POST', headers: admin })).status, 404);
  assert.doesNotMatch(await (await fetch(`${offUrl}/metrics`)).text(), /teriac_backup/);
  off.close();
  store.close();
});

test('rclone errors are cut down to the message from the storage service', () => {
  const s3 = '2026/11/11 19:50:01 ERROR : error listing: operation error S3: ListObjects, https response error StatusCode: 403, RequestID: , HostID: , api error InvalidAccessKeyId: The Access Key Id you provided does not exist in our records.\n2026/11/11 19:50:01 NOTICE: Failed to lsf with 2 errors: last error was: error in ListJSON: operation error S3: ListObjects, https response error StatusCode: 403, api error InvalidAccessKeyId: The Access Key Id you provided does not exist in our records.\n';
  assert.equal(rcloneError(s3), 'InvalidAccessKeyId: The Access Key Id you provided does not exist in our records.');
  assert.equal(rcloneError('2026/11/11 19:50:01 CRITICAL: Failed to create file system: didn\'t find section in config file\n'), "Failed to create file system: didn't find section in config file");
  assert.equal(rcloneError(''), '');
});
