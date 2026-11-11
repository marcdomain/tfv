// teriac-server entry point.
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { log, addSecret, addSecretsFromEnv } from './log.ts';

// Configuration mistakes get one clear line, not a stack trace.
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  const message = e.code === 'ENOENT' ? `cannot read ${e.path}: file not found` : e.message;
  log.error(`teriac-server cannot start: ${message}`);
  process.exit(1);
}

// teriac's core keeps tool binaries under TERIAC_HOME; it must be set before the core loads.
process.env.TERIAC_HOME = join(config.dataDir, 'teriac');
mkdirSync(join(config.dataDir, 'plugin-cache'), { recursive: true });
addSecretsFromEnv(process.env);
addSecret(config.github?.privateKey);

const { Store } = await import('./store.ts');
const { App } = await import('./app.ts');
const { GitHubAdapter } = await import('./vcs/github.ts');
const { createHttpServer } = await import('./http.ts');
const { teriacResolver } = await import('./runner.ts');
const { teriac, setDownloadToken } = await import('./teriac.ts');
const { DriftScheduler } = await import('./drift.ts');
const { Oidc } = await import('./auth.ts');
const { Avatars } = await import('./avatars.ts');
const { GrantWatcher } = await import('./grants.ts');
const { SummaryScheduler } = await import('./summary.ts');

const { BackupScheduler, cleanLeftovers, destination, rcloneRemote, restoreLatest } = await import('./backup.ts');
const { notifyText } = await import('./notify.ts');

// Backups: remove what an interrupted backup or restore left, then restore an empty volume
// from the newest usable backup before the database opens.
const dbPath = join(config.dataDir, 'teriac.db');
cleanLeftovers(config.dataDir);
const remote = config.backup ? rcloneRemote(config.backup) : undefined;
if (config.backup && remote && !existsSync(dbPath)) {
  const where = destination(config.backup);
  try {
    const r = await restoreLatest(remote, dbPath, where);
    if (r.restored) log.info('database restored from backup', { from: where, backup: r.restored, skipped: r.skipped.length });
    else log.warn('no backups found; starting with an empty database', { at: where });
  } catch (err) {
    log.error(`teriac-server cannot start: ${(err as Error).message}`);
    process.exit(1);
  }
}

const store = new Store(dbPath);
const app = new App({ config, store, resolver: teriacResolver(config.defaultVersion) });
const adapters = { github: config.github ? new GitHubAdapter(config.github) : undefined };
const drift = new DriftScheduler({
  config, store, resolver: teriacResolver(config.defaultVersion),
  adapters: Object.values(adapters).filter(a => a !== undefined),
  limited: fn => app.limited(fn),
});
// Downloads of OpenTofu and Terragrunt from GitHub use the App's token (higher limits,
// and no anonymous-request timeouts), unless GITHUB_TOKEN is set. Installation tokens
// last an hour, so it's renewed every 45 minutes.
if (adapters.github && !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
  const gh = adapters.github;
  const renew = () => gh.downloadToken()
    .then(t => { setDownloadToken(t); if (!t) log.info('GitHub downloads are anonymous (no App installation on github.com)'); })
    .catch(err => log.warn('could not get a GitHub token for downloads; they stay anonymous', { err: (err as Error).message }));
  void renew();
  setInterval(renew, 45 * 60_000).unref();
}

// Channel secrets are referenced by env var name; keep their values out of logs.
for (const c of Object.values(config.channels)) {
  for (const name of [c.token_env, c.webhook_url_env]) if (name) addSecret(process.env[name]);
}

// Emergency access and the weekly summary share the channel settings.
const chat = { channels: config.channels, people: config.people, env: process.env, publicUrl: config.publicUrl };
const grantNotices = { store, cfg: config.breakGlass, ...chat };
const grants = new GrantWatcher(grantNotices);
const summary = new SummaryScheduler({ store, cfg: config.summary, ...chat });
const backups = config.backup && remote ? new BackupScheduler({
  cfg: config.backup, store, remote, dataDir: config.dataDir,
  notify: config.backup.notify.length
    ? (title, lines) => notifyText(config.backup!.notify, config.channels, { title, lines, event: 'teriac.backup', url: `${config.publicUrl}/#guardrails` }, { people: config.people, env: process.env })
    : undefined,
}) : undefined;

let ready = false;
let stopping = false;
const server = createHttpServer({
  app, store, adapters, drift, auth: config.auth,
  platforms: config.github ? { [config.github.host]: 'github' } : {},
  people: config.people,
  avatars: new Avatars(config.dataDir, config.github ? { [config.github.host]: 'github' } : {}),
  oidc: config.auth.oidc ? new Oidc(config.auth.oidc, config.publicUrl) : undefined,
  grants: grantNotices,
  backups,
  config,
  ready: () => ready && !stopping,
});
addSecret(config.auth.apiToken);
addSecret(config.auth.oidc?.clientSecret);
if (!process.env.TERIAC_SESSION_SECRET && !process.env.TERIAC_SESSION_SECRET_FILE) {
  log.warn('TERIAC_SESSION_SECRET is not set; dashboard sessions end when the server restarts');
}

server.listen(config.port, () => {
  ready = true;
  if (process.env.TERIAC_DRIFT !== 'false') drift.start();
  grants.start();
  summary.start();
  backups?.start();
  log.info('teriac-server listening', { port: config.port, dataDir: config.dataDir, repos: config.repos.map(r => r.id) });
});

// Optional warm-up, e.g. TERIAC_PREINSTALL="terraform@1.9.8,tofu@1.8.5,terragrunt@0.83.2"
const preinstall = (process.env.TERIAC_PREINSTALL ?? '').split(',').map(s => s.trim()).filter(Boolean);
for (const item of preinstall) {
  const [name, version] = item.split('@');
  const provider = name === 'tofu' ? 'opentofu' : name === 'tg' ? 'terragrunt' : name;
  teriac().installVersion(provider as 'terraform', version)
    .then(r => log.info('preinstalled', { provider: r.provider, version: r.version }))
    .catch(err => log.warn('preinstall failed', { item, err }));
}

// Kubernetes sends SIGTERM: stop taking work, let running plans/applies finish.
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info('shutting down; waiting for running jobs', { signal });
  server.close();
  drift.stop();
  grants.stop();
  summary.stop();
  backups?.stop();
  await Promise.all([app.idle(), drift.idle(), backups?.idle()]);
  store.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
