// tfv-server entry point.
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { log, addSecret, addSecretsFromEnv } from './log.ts';

// Configuration mistakes get one clear line, not a stack trace.
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  const message = e.code === 'ENOENT' ? `cannot read ${e.path}: file not found` : e.message;
  log.error(`tfv-server cannot start: ${message}`);
  process.exit(1);
}

// tfv's core keeps tool binaries under TFV_HOME; it must be set before the core loads.
process.env.TFV_HOME = join(config.dataDir, 'tfv');
mkdirSync(join(config.dataDir, 'plugin-cache'), { recursive: true });
addSecretsFromEnv(process.env);
addSecret(config.github?.privateKey);

const { Store } = await import('./store.ts');
const { App } = await import('./app.ts');
const { GitHubAdapter } = await import('./vcs/github.ts');
const { createHttpServer } = await import('./http.ts');
const { tfvResolver } = await import('./runner.ts');
const { tfv } = await import('./tfv.ts');
const { DriftScheduler } = await import('./drift.ts');
const { Oidc } = await import('./auth.ts');
const { Avatars } = await import('./avatars.ts');

const store = new Store(join(config.dataDir, 'tfv.db'));
const app = new App({ config, store, resolver: tfvResolver(config.defaultVersion) });
const adapters = { github: config.github ? new GitHubAdapter(config.github) : undefined };
const drift = new DriftScheduler({
  config, store, resolver: tfvResolver(config.defaultVersion),
  adapters: Object.values(adapters).filter(a => a !== undefined),
  limited: fn => app.limited(fn),
});
// Channel secrets are referenced by env var name; keep their values out of logs.
for (const c of Object.values(config.channels)) {
  for (const name of [c.token_env, c.webhook_url_env]) if (name) addSecret(process.env[name]);
}

let ready = false;
let stopping = false;
const server = createHttpServer({
  app, store, adapters, drift, auth: config.auth,
  platforms: config.github ? { [config.github.host]: 'github' } : {},
  people: config.people,
  avatars: new Avatars(config.dataDir, config.github ? { [config.github.host]: 'github' } : {}),
  oidc: config.auth.oidc ? new Oidc(config.auth.oidc, config.publicUrl) : undefined,
  ready: () => ready && !stopping,
});
addSecret(config.auth.apiToken);
addSecret(config.auth.oidc?.clientSecret);
if (!process.env.TFV_SESSION_SECRET && !process.env.TFV_SESSION_SECRET_FILE) {
  log.warn('TFV_SESSION_SECRET is not set; dashboard sessions end when the server restarts');
}

server.listen(config.port, () => {
  ready = true;
  if (process.env.TFV_DRIFT !== 'false') drift.start();
  log.info('tfv-server listening', { port: config.port, dataDir: config.dataDir, repos: config.repos.map(r => r.id) });
});

// Optional warm-up, e.g. TFV_PREINSTALL="terraform@1.9.8,tofu@1.8.5,terragrunt@0.83.2"
const preinstall = (process.env.TFV_PREINSTALL ?? '').split(',').map(s => s.trim()).filter(Boolean);
for (const item of preinstall) {
  const [name, version] = item.split('@');
  const provider = name === 'tofu' ? 'opentofu' : name === 'tg' ? 'terragrunt' : name;
  tfv().installVersion(provider as 'terraform', version)
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
  await Promise.all([app.idle(), drift.idle()]);
  store.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
