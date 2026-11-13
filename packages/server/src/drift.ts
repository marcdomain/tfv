// Scheduled drift detection: on a cron per project, plan the tip of a branch,
// find changes made outside Terraform, work out who last touched each
// resource, and tell a chat channel.
import { join } from 'node:path';
import type { ServerConfig, DriftSchedule, RepoPolicy } from './config.ts';
import type { Repo, VcsAdapter } from './vcs/types.ts';
import type { Store } from './store.ts';
import type { ToolResolver } from './runner.ts';
import { plan as runPlan, engineLabel, toolEnv, gitAuthEnv } from './runner.ts';
import { checkoutBranch } from './git.ts';
import { loadRepoConfig, loadRepoConfigFrom, emptyRepoConfig } from './repoConfig.ts';
import { discoverProjects, type Project } from './discovery.ts';
import { repoPolicyFor } from './policy.ts';
import { parseCron, cronMatches, nextRun, type Cron } from './cron.ts';
import { lastAuthor, type Author } from './blame.ts';
import { planDriftFix, driftFixBody } from './driftfix.ts';
import { notifyAll, type DriftReport, type ProjectDrift } from './notify.ts';
import { matchGlob } from './glob.ts';
import { KeyedQueue } from './app.ts';
import { log } from './log.ts';

export interface ScheduleEntry {
  key: string;
  source: 'server' | 'repo';
  adapter: VcsAdapter;
  repo: Repo;
  policy: RepoPolicy;
  branch: string;
  spec: DriftSchedule;
  cron: Cron;
}

export interface DriftDeps {
  config: ServerConfig;
  store: Store;
  adapters: VcsAdapter[];
  resolver: ToolResolver;
  limited: <T>(fn: () => Promise<T>) => Promise<T>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface DriftResult {
  report: DriftReport;
  notified: { channel: string; ok: boolean; error?: string }[] | null;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');
const minuteKey = (d: Date) => d.toISOString().slice(0, 16);

// Same findings → same fingerprint, so repeats can stay quiet.
export const fingerprint = (p: ProjectDrift) => JSON.stringify({
  drift: p.drift.map(d => `${d.action}:${d.address}`).sort(),
  pending: p.pending,
  error: p.error ? 'error' : null,
});

export class DriftScheduler {
  private deps: DriftDeps;
  private entries: ScheduleEntry[] = [];
  private queue = new KeyedQueue();
  private timer: NodeJS.Timeout | null = null;
  private refresher: NodeJS.Timeout | null = null;

  constructor(deps: DriftDeps) { this.deps = deps; }

  get schedules() { return this.entries; }

  // Loads schedules from repos.yaml and every allowed repo's teriac.yaml.
  async refresh(): Promise<void> {
    const { config } = this.deps;
    const entries: ScheduleEntry[] = [];
    for (const adapter of this.deps.adapters) {
      let repos: Repo[];
      try {
        repos = await adapter.listRepos();
      } catch (err) {
        log.warn('drift: could not list repos', { platform: adapter.platform, err });
        continue;
      }
      for (const repo of repos) {
        const policy = repoPolicyFor(config.repos, repo);
        if (!policy) continue;
        const id = `${repo.host}/${repo.fullName}`;
        const add = (spec: DriftSchedule, source: 'server' | 'repo', index: number) => {
          const branch = spec.branch ?? repo.defaultBranch ?? 'main';
          const missing = spec.notify.filter(c => !config.channels[c]);
          if (missing.length) {
            log.warn('drift: schedule names unknown channels; skipped', { repo: id, schedule: spec.name, missing });
            return;
          }
          entries.push({
            key: `${source}:${id}:${branch}:${spec.name ?? index}`,
            source, adapter, repo, policy, branch, spec, cron: parseCron(spec.schedule),
          });
        };
        // Server schedules name one exact repo.
        for (const r of config.repos) {
          if (r.id === id) (r.drift ?? []).forEach((d, i) => add(d, 'server', i));
        }
        if (policy.allow_repo_config === false || policy.allow_repo_schedules === false) continue;
        try {
          const rc = await loadRepoConfigFrom(f => adapter.fileAt(repo, f, repo.defaultBranch ?? 'main'));
          rc.drift.forEach((d, i) => add(d, 'repo', i));
        } catch (err) {
          log.warn('drift: bad teriac.yaml; its schedules are skipped', { repo: id, err });
        }
      }
    }
    this.entries = entries;
    log.info('drift schedules loaded', { count: entries.length });
  }

  start(): void {
    const tick = () => {
      this.tick(this.deps.now?.() ?? new Date());
      // Re-align to the start of each minute.
      this.timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
    };
    void this.refresh().then(() => tick());
    this.refresher = setInterval(() => void this.refresh(), 15 * 60_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.refresher) clearInterval(this.refresher);
  }

  idle() { return this.queue.idle(); }

  // Starts every schedule due at `now`. Each minute is claimed in the DB first.
  tick(now: Date): Promise<DriftResult | null>[] {
    const started: Promise<DriftResult | null>[] = [];
    for (const e of this.entries) {
      if (!cronMatches(e.cron, now, e.spec.timezone ?? 'UTC')) continue;
      if (!this.deps.store.claimDrift(e.key, minuteKey(now))) continue;
      started.push(this.run(e).catch(err => {
        log.error('drift run failed', { key: e.key, err });
        return null;
      }));
    }
    return started;
  }

  next(e: ScheduleEntry, from = new Date()) {
    return nextRun(e.cron, from, e.spec.timezone ?? 'UTC');
  }

  // One run of one schedule (also used for "run now").
  run(e: ScheduleEntry): Promise<DriftResult> {
    return this.queue.run(`${e.repo.host}/${e.repo.fullName}@${e.branch}`, () => this.execute(e));
  }

  private async execute(e: ScheduleEntry): Promise<DriftResult> {
    const { config, store } = this.deps;
    const repoKey = `${e.repo.host}/${e.repo.fullName}`;
    const root = join(config.dataDir, 'drift', e.repo.host, e.repo.owner, e.repo.name, slug(e.branch));
    const auth = await e.adapter.cloneAuth(e.repo);
    const sha = await checkoutBranch(root, auth, e.branch);
    // Read-only credentials for Terraform's git module downloads (TERIAC_MODULE_AUTH).
    const moduleAuth = config.moduleAuth !== false && e.adapter.moduleAuth
      ? await e.adapter.moduleAuth(e.repo).catch(err => { log.warn('no git credentials for module downloads', { repo: e.repo.fullName, err: (err as Error).message }); return null; })
      : null;
    const repoConfig = e.policy.allow_repo_config === false ? emptyRepoConfig() : loadRepoConfig(root);
    const projects = discoverProjects(root, repoConfig)
      .filter(p => e.spec.projects.some(g => matchGlob(g, p.name) || matchGlob(g, p.dir)));

    const findings = await Promise.all(projects.map(p => this.deps.limited(() => this.checkProject(e, root, auth, p, repoKey, moduleAuth))));

    const report: DriftReport = {
      repo: e.repo.fullName, host: e.repo.host, branch: e.branch, sha, schedule: e.spec.name ?? e.spec.schedule,
      projects: findings.filter(f => f.drift.length || f.error || (f.pending && Object.values(f.pending).some(Boolean))),
      cleanCount: 0, url: `${config.publicUrl}/`,
    };
    report.cleanCount = findings.length - report.projects.length;

    // Store every project; notify when something changed (or always, if asked).
    let changed = false;
    const ids: number[] = [];
    for (const f of findings) {
      const fp = fingerprint(f);
      if (store.lastDriftFingerprint(e.key, f.project) !== fp) changed = true;
      ids.push(store.saveDrift({
        scheduleKey: e.key, repo: repoKey, branch: e.branch, sha, project: f.project,
        status: f.error ? 'error' : f.drift.length || (f.pending && Object.values(f.pending).some(Boolean)) ? 'drift' : 'clean',
        fingerprint: fp, finding: JSON.stringify(f),
      }));
    }

    const hasFindings = report.projects.length > 0;
    const always = e.spec.notify_when === 'always';
    let notified: DriftResult['notified'] = null;
    if ((hasFindings && (changed || always)) || (always && !hasFindings)) {
      notified = await notifyAll(e.spec.notify, config.channels, report, {
        people: config.people, env: this.deps.env ?? process.env, fetchImpl: this.deps.fetchImpl,
      });
      store.markNotified(ids, JSON.stringify(notified));
    }
    log.info('drift run finished', { key: e.key, sha, projects: findings.length, withFindings: report.projects.length, notified: !!notified });
    return { report, notified };
  }

  private async fixPr(e: ScheduleEntry, root: string, project: Project, plan: Record<string, any>, drift: { address: string; author: Author | null }[], result: ProjectDrift) {
    if (!e.adapter.openPullRequest) { result.fixNote = 'drift-fix PRs are not supported on this platform'; return; }
    try {
      const fix = planDriftFix(root, project.dir, plan, new Map(drift.map(d => [d.address, d.author])));
      if (!fix.edits.length) { result.fixNote = 'no fix PR: nothing here can be updated in code automatically'; return; }
      const branch = driftBranch(project.name);
      const url = await e.adapter.openPullRequest(e.repo, {
        base: e.branch, branch, title: `Accept drift in ${project.name}`,
        body: driftFixBody(project.name, e.branch, fix, e.spec.name ?? e.spec.schedule), files: fix.files,
      });
      if (url) result.fixPr = url;
      else result.fixNote = `a drift-fix PR is already open (branch \`${branch}\`)`;
      this.deps.store.audit({ repo: `${e.repo.host}/${e.repo.fullName}`, pr: 0, user: 'teriac', action: 'drift_fix_pr', project: project.name, allowed: true, reason: url ? `opened ${url} (${fix.edits.length} edits)` : `skipped: branch ${branch} exists` });
    } catch (err) {
      log.warn('drift: could not open a fix PR', { project: project.name, err });
      result.fixNote = `could not open a fix PR: ${(err as Error).message.slice(0, 160)}`;
    }
  }

  private async checkProject(e: ScheduleEntry, root: string, auth: Awaited<ReturnType<VcsAdapter['cloneAuth']>>, project: Project, repoKey: string, moduleAuth: Awaited<ReturnType<VcsAdapter['cloneAuth']>> | null = null): Promise<ProjectDrift> {
    const { config, store } = this.deps;
    const last = store.lastApply(repoKey, project.name);
    const lastApply = last ? { user: last.user, pr: last.pr, at: last.finishedAt ?? last.startedAt } : null;
    let engine = '';
    try {
      const tools = await this.deps.resolver.resolve(root, project);
      engine = engineLabel(tools);
      const planDir = join(config.dataDir, 'drift-plans', e.repo.host, e.repo.owner, e.repo.name, slug(e.branch));
      const env = toolEnv(this.deps.env ?? process.env, {
        ...gitAuthEnv(this.deps.env ?? process.env, moduleAuth),
        TF_PLUGIN_CACHE_DIR: join(config.dataDir, 'plugin-cache'),
        TERIAC_PROJECT: project.name, TERIAC_WORKSPACE: project.workspace, TERIAC_REPO: e.repo.fullName, TERIAC_BRANCH: e.branch,
      });
      const base = { root, project, tools, env, timeoutMs: config.runTimeoutMs };

      const refresh = await runPlan({ ...base, planPath: join(planDir, `${slug(project.name)}.drift.tfplan`) }, { refreshOnly: true, noLock: true });
      if (!refresh.ok) return { project: project.name, engine, drift: [], pending: null, lastApply, error: lastLines(refresh.output) };

      let pending: ProjectDrift['pending'] = null;
      if (e.spec.include_pending !== false) {
        const full = await runPlan({ ...base, planPath: join(planDir, `${slug(project.name)}.pending.tfplan`) }, { noLock: true });
        if (full.ok && full.summary) {
          // Resources that drifted show up again as "changes"; count only the rest.
          const drifted = new Set(refresh.summary?.drift.map(d => d.address));
          const rest = full.summary.changes.filter(c => !drifted.has(c.address));
          pending = {
            add: rest.filter(c => c.action === 'create').length,
            change: rest.filter(c => c.action === 'update').length,
            destroy: rest.filter(c => c.action === 'delete').length,
            replace: rest.filter(c => c.action === 'replace').length,
          };
        }
      }

      const drift = [];
      for (const d of refresh.summary?.drift ?? []) {
        drift.push({ address: d.address, action: d.action, author: await lastAuthor(root, project.dir, d.address, auth).catch(() => null) });
      }
      const result: ProjectDrift = { project: project.name, engine, drift, pending, lastApply };
      if (drift.length && e.spec.fix_pr && refresh.plan) await this.fixPr(e, root, project, refresh.plan, drift, result);
      return result;
    } catch (err) {
      return { project: project.name, engine, drift: [], pending: null, lastApply, error: (err as Error).message };
    }
  }
}

// Opens a PR that updates the code to match the drifted values (fix_pr: true).
export const driftBranch = (project: string) => `teriac/drift-fix/${slug(project).toLowerCase()}`;

const lastLines = (text: string, n = 6) => text.trim().split('\n').filter(l => l.trim() && !/^[│╷╵]\s*$/.test(l)).slice(-n).join('\n');
