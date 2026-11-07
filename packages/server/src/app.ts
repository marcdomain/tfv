// Handles platform events: autoplan on push, comment commands, the Apply
// button, and cleanup when a PR closes.
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import type { ServerConfig, RepoPolicy, Action } from './config.ts';
import type { VcsAdapter, VcsEvent, Repo, PullRequestState } from './vcs/types.ts';
import { Store, type Run } from './store.ts';
import { parseCommand, helpText, type Command } from './commands.ts';
import { loadRepoConfig, loadRepoConfigFrom, emptyRepoConfig, type RepoConfig } from './repoConfig.ts';
import { discoverProjects, affectedProjects, type Project } from './discovery.ts';
import {
  repoPolicyFor, rulesFor, checkPermission, currentApprovers, applyBlockers, type Lookup, type EffectiveRules,
} from './policy.ts';
import { renderComment, renderCheck, type ProjectView } from './render.ts';
import { repoLinks, platformForHost } from './links.ts';
import { avatarSource } from './avatars.ts';
import { plan as runPlan, apply as runApply, engineLabel, toolEnv, type ToolResolver, type ToolSet } from './runner.ts';
import { checkout as gitCheckout } from './git.ts';
import { log } from './log.ts';
import { metrics } from './metrics.ts';

export const MARKER = '<!-- tfv:summary -->';

// Serializes work per key (one PR at a time) while other PRs run in parallel.
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.tails.set(key, next);
    next.finally(() => { if (this.tails.get(key) === next) this.tails.delete(key); }).catch(() => {});
    return next;
  }
  get size() { return this.tails.size; }
  async idle() { while (this.tails.size) await Promise.allSettled([...this.tails.values()]); }
}

// Caps how many terraform processes run at once across the server.
export class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];
  private max: number;
  constructor(max: number) { this.max = max; }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>(r => this.waiting.push(r));
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

export interface AppDeps {
  config: ServerConfig;
  store: Store;
  resolver: ToolResolver;
  checkout?: typeof gitCheckout;
  env?: NodeJS.ProcessEnv;
}

interface PrContext {
  adapter: VcsAdapter;
  repo: Repo;
  repoKey: string;
  policy: RepoPolicy;
  pr: PullRequestState;
  root: string;
  projects: Project[];
  rulesConfig: RepoConfig;        // from the base branch
  warnings: string[];
  lookup: Lookup;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

export class App {
  private queue = new KeyedQueue();
  private sem: Semaphore;
  private deps: AppDeps;
  private checkout: typeof gitCheckout;

  constructor(deps: AppDeps) {
    this.deps = deps;
    this.sem = new Semaphore(deps.config.parallelism);
    this.checkout = deps.checkout ?? gitCheckout;
    // Terraform refuses to use a plugin cache dir that doesn't exist.
    mkdirSync(join(deps.config.dataDir, 'plugin-cache'), { recursive: true });
  }

  idle() { return this.queue.idle(); }

  // Shares the server-wide limit on concurrent terraform processes (drift uses it too).
  limited<T>(fn: () => Promise<T>): Promise<T> { return this.sem.use(fn); }

  // Entry point for every webhook. Returns once the work has finished.
  async handle(adapter: VcsAdapter, event: VcsEvent): Promise<void> {
    if (event.kind === 'ignored') return;
    const policy = repoPolicyFor(this.deps.config.repos, event.repo);
    if (!policy) {
      log.info('repo not allowed; ignoring', { repo: `${event.repo.host}/${event.repo.fullName}` });
      return;
    }
    const number = 'pr' in event ? event.pr.number : event.prNumber;
    const key = `${event.repo.host}/${event.repo.fullName}#${number}`;
    return this.queue.run(key, async () => {
      try {
        switch (event.kind) {
          case 'pr_opened': case 'pr_updated': return await this.autoplan(adapter, policy, event.repo, number);
          case 'pr_closed': return await this.closed(event.repo, number);
          case 'comment': return await this.onComment(adapter, policy, event.repo, number, event.author, event.body, event.commentId);
          case 'apply_button':
            return await this.runCommand(adapter, policy, event.repo, number, event.user,
              { verb: 'apply', project: event.project, destroy: false, targets: [], extraArgs: [] });
        }
      } catch (err) {
        log.error('event failed', { key, kind: event.kind, err });
        await adapter.comment(event.repo, number, `⚠️ tfv hit an error: ${(err as Error).message}`).catch(() => {});
      }
    });
  }

  // ---- context ----

  private repoKey(repo: Repo) { return `${repo.host}/${repo.fullName}`; }

  private workDir(repo: Repo, pr: number) {
    return join(this.deps.config.dataDir, 'work', repo.host, repo.owner, repo.name, String(pr));
  }

  private planDir(repo: Repo, pr: number) {
    return join(this.deps.config.dataDir, 'plans', repo.host, repo.owner, repo.name, String(pr));
  }

  private async context(adapter: VcsAdapter, policy: RepoPolicy, repo: Repo, number: number): Promise<PrContext> {
    const pr = await adapter.getPullRequest(repo, number);
    const root = this.workDir(repo, number);
    await this.checkout(root, await adapter.cloneAuth(repo), pr.headSha, `refs/pull/${number}/head`);

    const allowRepoConfig = policy.allow_repo_config !== false;
    const headConfig = allowRepoConfig ? loadRepoConfig(root) : emptyRepoConfig();
    // Rules come from the base branch, so a PR can't loosen its own rules.
    const rulesConfig = allowRepoConfig
      ? await loadRepoConfigFrom(f => adapter.fileAt(repo, f, pr.baseRef))
      : headConfig;
    const projects = discoverProjects(root, headConfig);
    const lookup: Lookup = {
      permission: u => adapter.userPermission(repo, u),
      inTeam: (t, u) => adapter.inTeam(repo, t, u),
      codeowners: () => adapter.codeowners(repo, pr.baseRef),
    };
    return {
      adapter, repo, repoKey: this.repoKey(repo), policy, pr, root, projects, rulesConfig,
      warnings: headConfig.warnings, lookup,
    };
  }

  private rules(ctx: PrContext, project: Project): EffectiveRules {
    return rulesFor(project, ctx.policy, ctx.rulesConfig);
  }

  private async allowed(ctx: PrContext, action: Action, user: string, project: Project) {
    const decision = await checkPermission(action, user, project, this.rules(ctx, project), ctx.lookup);
    this.deps.store.audit({
      repo: ctx.repoKey, pr: ctx.pr.number, user, action, project: project.name,
      allowed: decision.allowed, reason: decision.reason,
    });
    return decision;
  }

  // ---- events ----

  private async autoplan(adapter: VcsAdapter, policy: RepoPolicy, repo: Repo, number: number) {
    if (policy.autoplan === false) return;
    const ctx = await this.context(adapter, policy, repo, number);
    if (ctx.pr.draft && !policy.plan_drafts) return;
    const targets = affectedProjects(ctx.projects, await adapter.changedFiles(repo, number));
    const hadRuns = this.deps.store.latestRuns(ctx.repoKey, number, 'plan').length > 0;
    if (!targets.length && !hadRuns) return;

    // Autoplan runs the PR's code, so the author needs plan rights
    // (stops strangers' fork PRs from running anything).
    const notes = new Map<string, string>();
    const allowedTargets: Project[] = [];
    for (const p of targets) {
      const d = await this.allowed(ctx, 'plan', ctx.pr.author, p);
      if (d.allowed) allowedTargets.push(p);
      else notes.set(p.name, `not planned automatically: ${d.reason}. Someone allowed can comment \`tfv plan\`.`);
    }
    await this.plans(ctx, allowedTargets, ctx.pr.author, {}, notes);
  }

  private async closed(repo: Repo, number: number) {
    const released = this.deps.store.releasePrLocks(this.repoKey(repo), number);
    this.deps.store.discardPlans(this.repoKey(repo), number);
    rmSync(this.workDir(repo, number), { recursive: true, force: true });
    rmSync(this.planDir(repo, number), { recursive: true, force: true });
    log.info('PR closed; cleaned up', { repo: repo.fullName, pr: number, released });
  }

  private async onComment(adapter: VcsAdapter, policy: RepoPolicy, repo: Repo, number: number, author: string, body: string, commentId: string) {
    const parsed = parseCommand(body, this.deps.config.commandNames);
    if (!parsed) return;
    await adapter.react(repo, number, commentId, 'eyes');
    if (!parsed.ok) {
      await adapter.comment(repo, number, `❌ ${parsed.error}`);
      return;
    }
    await this.runCommand(adapter, policy, repo, number, author, parsed.command);
  }

  private select(ctx: PrContext, cmd: Command, fallback: Project[]): Project[] | string {
    if (!cmd.project && !cmd.dir && !cmd.workspace) return fallback;
    const hits = ctx.projects.filter(p =>
      (!cmd.project || p.name === cmd.project)
      && (!cmd.dir || p.dir === cmd.dir)
      && (!cmd.workspace || p.workspace === cmd.workspace));
    if (!hits.length) {
      const what = [cmd.project && `project \`${cmd.project}\``, cmd.dir && `dir \`${cmd.dir}\``, cmd.workspace && `workspace \`${cmd.workspace}\``].filter(Boolean).join(', ');
      return `No project matches ${what}. Known projects: ${ctx.projects.map(p => `\`${p.name}\``).join(', ') || 'none'}`;
    }
    return hits;
  }

  private async runCommand(adapter: VcsAdapter, policy: RepoPolicy, repo: Repo, number: number, user: string, cmd: Command) {
    const name = this.deps.config.commandNames[0];
    if (cmd.verb === 'help') {
      await adapter.comment(repo, number, helpText(name));
      return;
    }
    if (cmd.targets.length && policy.allow_targets === false) {
      await adapter.comment(repo, number, '❌ Targeted plans are turned off for this repo (`allow_targets` in repos.yaml).');
      return;
    }
    if (cmd.extraArgs.length && !policy.allow_extra_args) {
      await adapter.comment(repo, number, '❌ Extra arguments are turned off for this repo (`allow_extra_args` in repos.yaml).');
      return;
    }

    const ctx = await this.context(adapter, policy, repo, number);
    if (!ctx.pr.open) {
      await adapter.comment(repo, number, '❌ This PR is closed.');
      return;
    }

    if (cmd.verb === 'unlock') return this.unlock(ctx, user, cmd);

    if (cmd.verb === 'plan') {
      const changed = affectedProjects(ctx.projects, await adapter.changedFiles(repo, number));
      const targets = this.select(ctx, cmd, changed);
      if (typeof targets === 'string') return adapter.comment(repo, number, `❌ ${targets}`);
      if (!targets.length) return adapter.comment(repo, number, 'No projects changed in this PR. Use `-p <project>` to plan one anyway.');
      const notes = new Map<string, string>();
      const allowed: Project[] = [];
      for (const p of targets) {
        const d = await this.allowed(ctx, 'plan', user, p);
        if (d.allowed) allowed.push(p); else notes.set(p.name, `🚫 ${d.reason}`);
      }
      await this.plans(ctx, allowed, user, { destroy: cmd.destroy, targets: cmd.targets, extraArgs: cmd.extraArgs }, notes);
      return;
    }

    return this.applyCommand(ctx, user, cmd);
  }

  // ---- plan ----

  private async plans(ctx: PrContext, targets: Project[], user: string, opts: { destroy?: boolean; targets?: string[]; extraArgs?: string[] }, notes: Map<string, string>) {
    const { store } = this.deps;
    await Promise.all(targets.map(project => this.sem.use(async () => {
      const lock = store.acquireLock(ctx.repoKey, project.name, project.workspace, ctx.pr.number, user);
      if (!lock.ok) {
        notes.set(project.name, `🔒 locked by #${lock.heldBy.pr} (${lock.heldBy.user}); apply or unlock it there first`);
        return;
      }
      await this.planProject(ctx, project, user, opts);
    })));
    await this.refreshComment(ctx, notes);
  }

  private async tools(ctx: PrContext, project: Project): Promise<ToolSet> {
    return this.deps.resolver.resolve(ctx.root, project);
  }

  private env(ctx: PrContext, project: Project, user: string) {
    return toolEnv(this.deps.env ?? process.env, {
      TF_PLUGIN_CACHE_DIR: join(this.deps.config.dataDir, 'plugin-cache'),
      TFV_PR_NUMBER: String(ctx.pr.number),
      TFV_HEAD_SHA: ctx.pr.headSha,
      TFV_PROJECT: project.name,
      TFV_WORKSPACE: project.workspace,
      TFV_USER: user,
      TFV_REPO: ctx.repo.fullName,
    });
  }

  private planPath(ctx: PrContext, project: Project) {
    return join(this.planDir(ctx.repo, ctx.pr.number), `${slug(project.name)}-${slug(project.workspace)}.tfplan`);
  }

  private async planProject(ctx: PrContext, project: Project, user: string, opts: { destroy?: boolean; targets?: string[]; extraArgs?: string[] }) {
    const { store, config } = this.deps;
    const checkName = `tfv: ${project.name}`;
    const started = Date.now();
    const runId = store.startRun({ repo: ctx.repoKey, pr: ctx.pr.number, project: project.name, workspace: project.workspace, kind: 'plan', headSha: ctx.pr.headSha, user, targets: opts.targets, prAuthor: ctx.pr.author, dir: project.dir });
    await this.check(ctx, { name: checkName, headSha: ctx.pr.headSha, externalId: project.name, status: 'in_progress', title: 'Planning…', summary: `Planning \`${project.name}\`` });

    let engine = '';
    try {
      const tools = await this.tools(ctx, project);
      engine = engineLabel(tools);
      const planPath = this.planPath(ctx, project);
      const r = await runPlan({
        root: ctx.root, project, tools, planPath, env: this.env(ctx, project, user), timeoutMs: config.runTimeoutMs,
      }, opts);
      const destroys = r.summary ? r.summary.destroy + r.summary.replace : 0;
      store.finishRun(runId, {
        status: r.ok ? 'success' : 'failed', engine, summary: r.summary ? JSON.stringify(r.summary) : null,
        output: r.output, planPath: r.ok ? planPath : null, hasChanges: r.hasChanges, destroys,
      });
    } catch (err) {
      store.finishRun(runId, { status: 'failed', engine, output: `tfv could not run this project: ${(err as Error).message}` });
    }
    metrics.observeRun('plan', store.getRun(runId)!.status, Date.now() - started);
    await this.publishCheck(ctx, project, store.getRun(runId)!);
  }

  // ---- apply ----

  private async approvers(ctx: PrContext) {
    return currentApprovers(await ctx.adapter.reviews(ctx.repo, ctx.pr.number), ctx.pr.author, ctx.pr.headSha);
  }

  // Projects in dependency order: a project runs after the projects it depends on.
  private ordered(projects: Project[]): Project[] {
    const out: Project[] = [];
    const seen = new Set<string>();
    const visit = (p: Project, stack: Set<string>) => {
      if (seen.has(p.name) || stack.has(p.name)) return;
      stack.add(p.name);
      for (const q of projects) if (p.deps.includes(q.dir)) visit(q, stack);
      seen.add(p.name);
      out.push(p);
    };
    for (const p of projects) visit(p, new Set());
    return out;
  }

  private oneAtATime(ctx: PrContext): boolean {
    return this.deps.config.requireApplyProject || ctx.policy.require_apply_project === true || ctx.rulesConfig.require_apply_project;
  }

  private async applyCommand(ctx: PrContext, user: string, cmd: Command) {
    const { store } = this.deps;
    const plans = new Map(store.latestRuns(ctx.repoKey, ctx.pr.number, 'plan')
      .filter(r => r.headSha === ctx.pr.headSha)
      .map(r => [`${r.project}::${r.workspace}`, r]));
    const planned = ctx.projects.filter(p => {
      const r = plans.get(`${p.name}::${p.workspace}`);
      return r && r.status === 'success' && r.hasChanges && r.planPath;
    });
    // Servers (or repos) can insist on one project per apply.
    if (this.oneAtATime(ctx) && !cmd.project && !cmd.dir) {
      const name = this.deps.config.commandNames[0];
      const ready = planned.map(p => `- \`${name} apply -p ${p.name}\``);
      return ctx.adapter.comment(ctx.repo, ctx.pr.number, [
        `@${user} this server applies one project at a time, so \`${name} apply\` on its own is turned off.`,
        ready.length ? `Apply each project with:\n${ready.join('\n')}` : 'No project has a plan ready to apply yet.',
      ].join('\n\n'));
    }

    const selected = this.select(ctx, cmd, planned);
    if (typeof selected === 'string') return ctx.adapter.comment(ctx.repo, ctx.pr.number, `❌ ${selected}`);
    if (!selected.length) {
      return ctx.adapter.comment(ctx.repo, ctx.pr.number,
        'Nothing to apply: no project has a successful plan with changes at the current commit. Run `tfv plan` first.');
    }

    const approvers = await this.approvers(ctx);
    const notes = new Map<string, string>();
    const denied: string[] = [];
    for (const project of this.ordered(selected)) {
      const plan = plans.get(`${project.name}::${project.workspace}`);
      if (!plan || plan.status !== 'success' || !plan.planPath) {
        notes.set(project.name, 'no plan at the current commit; run `tfv plan` first');
        continue;
      }
      if (!plan.hasChanges) continue;

      const lock = store.acquireLock(ctx.repoKey, project.name, project.workspace, ctx.pr.number, user);
      if (!lock.ok) { notes.set(project.name, `🔒 locked by #${lock.heldBy.pr}`); continue; }

      const action: Action = plan.destroys > 0 ? 'apply_destroy' : 'apply';
      const perm = await this.allowed(ctx, 'apply', user, project);
      const permDestroy = action === 'apply_destroy' && perm.allowed ? await this.allowed(ctx, 'apply_destroy', user, project) : perm;
      if (!perm.allowed || !permDestroy.allowed) {
        const reason = !perm.allowed ? perm.reason : `${permDestroy.reason} (this plan destroys or replaces ${plan.destroys} resource${plan.destroys === 1 ? '' : 's'})`;
        denied.push(`- \`${project.name}\`: ${reason}`);
        continue;
      }

      const blockers = await applyBlockers(project, this.rules(ctx, project), ctx.pr, approvers, ctx.lookup);
      if (blockers.length) {
        denied.push(`- \`${project.name}\`: ${blockers.join('; ')}`);
        continue;
      }
      await this.sem.use(() => this.applyProject(ctx, project, user, plan));
    }

    await this.refreshComment(ctx, notes);
    if (denied.length) {
      await ctx.adapter.comment(ctx.repo, ctx.pr.number, `@${user} these projects were not applied:\n${denied.join('\n')}`);
    }
  }

  private async applyProject(ctx: PrContext, project: Project, user: string, plan: Run) {
    const { store, config } = this.deps;
    const started = Date.now();
    const runId = store.startRun({ repo: ctx.repoKey, pr: ctx.pr.number, project: project.name, workspace: project.workspace, kind: 'apply', headSha: ctx.pr.headSha, user, prAuthor: ctx.pr.author, dir: project.dir });
    await this.check(ctx, { name: `tfv: ${project.name}`, headSha: ctx.pr.headSha, externalId: project.name, status: 'in_progress', title: 'Applying…', summary: `Applying \`${project.name}\` for @${user}` });
    let engine = plan.engine;
    try {
      const tools = await this.tools(ctx, project);
      engine = engineLabel(tools);
      const r = await runApply({ root: ctx.root, project, tools, planPath: plan.planPath!, env: this.env(ctx, project, user), timeoutMs: config.runTimeoutMs });
      store.finishRun(runId, { status: r.ok ? 'success' : 'failed', engine, output: r.output, summary: plan.summary });
    } catch (err) {
      store.finishRun(runId, { status: 'failed', engine, output: `tfv could not apply this project: ${(err as Error).message}` });
    }
    metrics.observeRun('apply', store.getRun(runId)!.status, Date.now() - started);
    await this.publishCheck(ctx, project, store.getRun(runId)!);
  }

  // ---- unlock ----

  private async unlock(ctx: PrContext, user: string, cmd: Command) {
    const { store } = this.deps;
    // These locks belong to this PR: its author or anyone who may plan here can drop them.
    const locks = store.locksForPr(ctx.repoKey, ctx.pr.number)
      .filter(l => !cmd.project || l.project === cmd.project);
    const isAuthor = user.toLowerCase() === ctx.pr.author.toLowerCase();
    const released: string[] = [];
    for (const l of locks) {
      const project = ctx.projects.find(p => p.name === l.project) ?? { name: l.project, dir: l.project } as Project;
      const ok = isAuthor || (await this.allowed(ctx, 'plan', user, project)).allowed;
      if (!ok) continue;
      store.releaseLock(l.repo, l.project, l.workspace);
      released.push(l.project);
    }
    if (!cmd.project) store.discardPlans(ctx.repoKey, ctx.pr.number);
    await ctx.adapter.comment(ctx.repo, ctx.pr.number, released.length
      ? `🔓 Unlocked ${released.map(p => `\`${p}\``).join(', ')} and discarded the plans. Run \`tfv plan\` to plan again.`
      : 'This PR holds no locks you can release.');
  }

  // ---- output ----

  private async check(ctx: PrContext, check: Parameters<VcsAdapter['setCheck']>[1]) {
    if (!ctx.adapter.supportsChecks) return;
    await ctx.adapter.setCheck(ctx.repo, { ...check, detailsUrl: `${this.deps.config.publicUrl}/` }).catch(err => log.warn('check update failed', { err }));
  }

  private async publishCheck(ctx: PrContext, project: Project, run: Run) {
    if (!ctx.adapter.supportsChecks) return;
    let blockers: string[] | undefined;
    if (run.kind === 'plan' && run.status === 'success' && run.hasChanges) {
      blockers = await applyBlockers(project, this.rules(ctx, project), ctx.pr, await this.approvers(ctx), ctx.lookup);
    }
    const out = renderCheck(project.name, run, blockers);
    const canApply = run.kind === 'plan' && run.status === 'success' && run.hasChanges;
    await this.check(ctx, {
      name: `tfv: ${project.name}`, headSha: run.headSha, externalId: project.name, status: 'completed',
      conclusion: run.status === 'success' ? (canApply ? 'neutral' : 'success') : 'failure',
      title: out.title, summary: out.summary, text: out.text,
      actions: canApply ? [{ label: 'Apply', identifier: 'apply', description: `Apply ${project.name}`.slice(0, 40) }] : undefined,
    });
  }

  private async refreshComment(ctx: PrContext, notes: Map<string, string>) {
    const { store, config } = this.deps;
    const head = ctx.pr.headSha;
    const plans = store.latestRuns(ctx.repoKey, ctx.pr.number, 'plan').filter(r => r.headSha === head);
    const applies = new Map(store.latestRuns(ctx.repoKey, ctx.pr.number, 'apply').map(r => [`${r.project}::${r.workspace}`, r]));
    const approvers = plans.some(p => p.status === 'success' && p.hasChanges) ? await this.approvers(ctx) : [];

    const views: ProjectView[] = [];
    for (const plan of plans) {
      const project = ctx.projects.find(p => p.name === plan.project) ?? { name: plan.project, dir: plan.project, deps: [] } as unknown as Project;
      const view: ProjectView = { name: plan.project, plan, apply: applies.get(`${plan.project}::${plan.workspace}`), note: notes.get(plan.project), dir: project.dir };
      if (plan.status === 'success' && plan.hasChanges) {
        view.blockers = await applyBlockers(project, this.rules(ctx, project), ctx.pr, approvers, ctx.lookup);
      }
      views.push(view);
    }
    for (const [name, note] of notes) if (!views.some(v => v.name === name)) views.push({ name, note });
    if (!views.length) return;
    views.sort((a, b) => a.name.localeCompare(b.name));

    const l = repoLinks(ctx.repoKey, platformForHost(ctx.repo.host, { [ctx.repo.host]: ctx.repo.platform }));
    const body = renderComment({
      marker: MARKER, headSha: head, command: config.commandNames[0], projects: views,
      dashboardUrl: config.publicUrl, limit: ctx.adapter.commentLimit, warnings: ctx.warnings,
      oneProjectPerApply: this.oneAtATime(ctx),
      approvers,
      links: {
        commit: sha => l.commit(sha),
        tree: (sha, dir) => l.tree(sha, dir),
        user: login => l.user(login),
        avatar: login => (avatarSource(ctx.repo.platform, ctx.repo.host, login) ? `https://${ctx.repo.host}/${encodeURIComponent(login)}.png?size=36` : null),
        run: id => `${config.publicUrl}/#runs/${id}`,
      },
    });
    await ctx.adapter.upsertComment(ctx.repo, ctx.pr.number, MARKER, body);
  }
}
