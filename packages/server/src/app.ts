// Handles platform events: autoplan on push, comment commands, the Apply
// button, and cleanup when a PR closes.
import { join } from 'node:path';
import { rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import type { ServerConfig, RepoPolicy, Action } from './config.ts';
import type { VcsAdapter, VcsEvent, Repo, PullRequestState } from './vcs/types.ts';
import { Store, type Run } from './store.ts';
import { parseCommand, helpText, toolArgs, TOOL_ACTION, EDITS_STATE, type Command } from './commands.ts';
import { loadRepoConfig, loadRepoConfigFrom, emptyRepoConfig, type RepoConfig } from './repoConfig.ts';
import { discoverProjects, affectedProjects, terragruntDependencies, mockedDependencies, unappliedDependencies, type Project } from './discovery.ts';
import {
  repoPolicyFor, rulesFor, checkPermission, currentApprovers, applyBlockers, matchesPrincipal, type Lookup, type EffectiveRules,
} from './policy.ts';
import { renderComment, renderCheck, renderApplyReport, parseApplyResult, providersOf, cmdBlock, fence, tail, type ProjectView, type CommentLinks } from './render.ts';
import { repoLinks, platformForHost } from './links.ts';
import { avatarSource } from './avatars.ts';
import { plan as runPlan, apply as runApply, runTool, engineLabel, toolEnv, type ToolResolver, type ToolSet } from './runner.ts';
import { checkout as gitCheckout } from './git.ts';
import { log } from './log.ts';
import { evaluateRules, runCommands, stricter, type PolicyConfig, type PolicyResult } from './policies.ts';
import { matchGlob } from './glob.ts';
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

// Shares the server's run slots fairly between PRs (and drift checks).
// - at most `max` runs at once in total;
// - one PR (group) holds at most `perGroup` of them, so others always get a slot;
// - a freed slot goes to the waiting group with the fewest runs going.
export class FairScheduler {
  private max: number;
  private perGroup: number;
  private active = 0;
  private running = new Map<string, number>();
  private waiting: { group: string; go: () => void }[] = [];

  constructor(max: number, perGroup: number) {
    this.max = Math.max(1, max);
    this.perGroup = Math.max(1, Math.min(perGroup, this.max));
  }

  private count(g: string) { return this.running.get(g) ?? 0; }
  private fits(g: string) { return this.active < this.max && this.count(g) < this.perGroup; }
  private take(g: string) { this.active++; this.running.set(g, this.count(g) + 1); }

  private pump() {
    while (this.active < this.max) {
      let best = -1;
      for (let i = 0; i < this.waiting.length; i++) {
        const g = this.waiting[i].group;
        if (this.count(g) >= this.perGroup) continue;
        if (best < 0 || this.count(g) < this.count(this.waiting[best].group)) best = i;
      }
      if (best < 0) return;
      const [w] = this.waiting.splice(best, 1);
      this.take(w.group);
      w.go();
    }
  }

  async use<T>(group: string, fn: () => Promise<T>): Promise<T> {
    if (this.fits(group) && !this.waiting.length) this.take(group);
    else await new Promise<void>(go => { this.waiting.push({ group, go }); this.pump(); });
    try {
      return await fn();
    } finally {
      this.active--;
      const n = this.count(group) - 1;
      if (n > 0) this.running.set(group, n); else this.running.delete(group);
      this.pump();
    }
  }

  get stats() { return { active: this.active, waiting: this.waiting.length, groups: Object.fromEntries(this.running) }; }
}

// One reply per command, right under it. In "loading" mode it appears at once
// as "⏳ Running …" and is edited into the outcome when the command finishes.
export class Reply {
  private adapter: VcsAdapter;
  private repo: Repo;
  private number: number;
  private spinner: string | null;
  private id: string | null = null;
  private lines: string[] = [];
  // `spinner` is the animated icon's URL; without one there is no "Running…" reply.
  constructor(adapter: VcsAdapter, repo: Repo, number: number, spinner: string | null) {
    this.adapter = adapter; this.repo = repo; this.number = number; this.spinner = spinner;
  }
  async start(text: string) {
    if (!this.spinner) return;
    // alt="👀": if GitHub can't load the picture, the eyes show instead.
    const icon = `<img src="${this.spinner}" width="16" height="16" align="center" alt="👀">`;
    this.id = await this.adapter.comment(this.repo, this.number, `${icon} ${text}`).catch(() => null);
  }
  say(text: string) { this.lines.push(text); }
  async send() {
    // A "Running…" reply must never be left spinning.
    if (!this.lines.length && this.id) this.lines.push('✅ Done.');
    if (!this.lines.length) return;
    const body = this.lines.join('\n\n');
    if (this.id) await this.adapter.editComment(this.repo, this.id, body);
    else await this.adapter.comment(this.repo, this.number, body);
    this.lines = [];
  }
}

const sizeText = (summary: string | null): string => {
  if (!summary) return '';
  const x = JSON.parse(summary) as { add: number; change: number; destroy: number; replace: number; noChanges: boolean };
  if (x.noChanges) return 'no changes';
  return [x.add && `+${x.add}`, x.change && `~${x.change}`, x.replace && `±${x.replace}`, x.destroy && `−${x.destroy}`].filter(Boolean).join(' ') || 'outputs only';
};

// What a plan can be asked for from a PR comment.
type PlanOpts = { destroy?: boolean; targets?: string[]; extraArgs?: string[]; refreshOnly?: boolean; replace?: string[] };

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
  summaryUrl?: string | null;     // the summary comment, for links from replies
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_');

export class App {
  private queue = new KeyedQueue();
  // Check page per PR project (where GitHub shows the Apply button).
  private checkUrls = new Map<string, string>();
  private sched: FairScheduler;
  private deps: AppDeps;
  private checkout: typeof gitCheckout;

  constructor(deps: AppDeps) {
    this.deps = deps;
    this.sched = new FairScheduler(deps.config.parallelism, deps.config.prParallelism ?? Math.max(1, deps.config.parallelism - 1));
    this.checkout = deps.checkout ?? gitCheckout;
    // Terraform refuses to use a plugin cache dir that doesn't exist.
    mkdirSync(join(deps.config.dataDir, 'plugin-cache'), { recursive: true });
  }

  idle() { return this.queue.idle(); }

  // Shares the server-wide limit on concurrent terraform processes (drift uses it too).
  limited<T>(fn: () => Promise<T>, group = 'drift'): Promise<T> { return this.sched.use(group, fn); }
  get schedulerStats() { return this.sched.stats; }

  // Entry point for every webhook. Returns once the work has finished.
  // Newest commit of each PR, recorded as push events arrive (before they queue), so
  // plans still waiting for an older commit can skip themselves and free the slot.
  private latestHead = new Map<string, string>();
  private outdated(ctx: PrContext): boolean {
    const latest = this.latestHead.get(`${ctx.repoKey}#${ctx.pr.number}`);
    return !!latest && latest !== ctx.pr.headSha;
  }

  // Runs going and waiting right now, for the Metrics page.
  get runQueue() { return this.sched.stats; }

  // Wraps an adapter so every comment tfv writes is remembered exactly as written.
  private recording(adapter: VcsAdapter): VcsAdapter {
    const store = this.deps.store;
    const keyOf = (repo: Repo) => `${repo.host}/${repo.fullName}`;
    const prOf = new Map<string, number>();
    return Object.assign(Object.create(adapter), {
      comment: async (repo: Repo, number: number, body: string) => {
        const id = await adapter.comment(repo, number, body);
        if (id) { prOf.set(id, number); store.rememberBotComment(keyOf(repo), number, id, body); }
        return id;
      },
      editComment: async (repo: Repo, id: string, body: string) => {
        await adapter.editComment(repo, id, body);
        const pr = prOf.get(id) ?? store.botComment(keyOf(repo), id)?.pr;
        if (pr !== undefined) store.rememberBotComment(keyOf(repo), pr, id, body);
      },
      upsertComment: async (repo: Repo, number: number, marker: string, body: string, knownId?: string | null) => {
        const r = await adapter.upsertComment(repo, number, marker, body, knownId);
        if (r) { prOf.set(r.id, number); store.rememberBotComment(keyOf(repo), number, r.id, body); }
        return r;
      },
    }) as VcsAdapter;
  }

  // Someone edited or deleted tfv's comment. It's left as it is; tfv posts a warning
  // that links to it and carries the original, and audits it. (tfv never reads its
  // comments back, so an edit can't change what gets applied.)
  private async commentChanged(adapter: VcsAdapter, e: Extract<VcsEvent, { kind: 'bot_comment_changed' }>): Promise<void> {
    const repoKey = `${e.repo.host}/${e.repo.fullName}`;
    const saved = this.deps.store.botComment(repoKey, e.commentId);
    if (!saved) return; // another bot's comment
    if (e.change === 'edited' && e.body === saved.body) return;
    const url = repoLinks(repoKey, platformForHost(e.repo.host, { [e.repo.host]: e.repo.platform })).comment(e.prNumber, e.commentId);
    // The original, minus tfv's hidden markers so it is never mistaken for the live comment.
    const original = saved.body.replace(/<!--\s*tfv:[^>]*-->\n?/g, '');
    const room = adapter.commentLimit - 1200;
    const shown = original.length > room ? `${original.slice(0, room)}\n\n_…cut short; the full plan is on the check run and the dashboard._` : original;
    await adapter.comment(e.repo, e.prNumber, [
      '> [!WARNING]',
      e.change === 'edited'
        ? `> **[tfv's comment](${url}) was edited by ${e.by}.** It no longer shows what tfv wrote. This was logged.`
        : `> **A tfv comment was deleted by ${e.by}.** This was logged.`,
      `> tfv only acts on its own records (saved plans, check runs, the dashboard), never on comment text.`,
      '',
      `<details><summary>View the original</summary>`,
      '',
      shown,
      '',
      '</details>',
    ].join('\n'));
    this.deps.store.audit({ repo: repoKey, pr: e.prNumber, user: e.by, action: `comment_${e.change}`, project: '', allowed: false, reason: `${e.change} tfv comment ${e.commentId} (${url})` });
    log.warn('tfv comment changed by someone else', { repo: repoKey, pr: e.prNumber, by: e.by, change: e.change });
  }

  async handle(rawAdapter: VcsAdapter, event: VcsEvent): Promise<void> {
    if (event.kind === 'ignored') return;
    const adapter = this.recording(rawAdapter);
    const policy = repoPolicyFor(this.deps.config.repos, event.repo);
    if (!policy) {
      log.info('repo not allowed; ignoring', { repo: `${event.repo.host}/${event.repo.fullName}` });
      return;
    }
    const number = 'pr' in event ? event.pr.number : event.prNumber;
    const key = `${event.repo.host}/${event.repo.fullName}#${number}`;
    if (event.kind === 'pr_opened' || event.kind === 'pr_updated') this.latestHead.set(key, event.pr.headSha);
    if (event.kind === 'pr_closed') this.latestHead.delete(key);
    return this.queue.run(key, async () => {
      try {
        switch (event.kind) {
          case 'pr_opened': case 'pr_updated': return await this.autoplan(adapter, policy, event.repo, number);
          case 'pr_closed': return await this.closed(event.repo, number);
          case 'bot_comment_changed': return await this.commentChanged(adapter, event);
          case 'comment': return await this.onComment(adapter, policy, event.repo, number, event.author, event.body, event.commentId);
          case 'apply_button': {
            const reply = new Reply(adapter, event.repo, number, this.spinner(policy));
            await reply.start(`Applying \`${event.project}\` (Apply button pressed by ${event.user})…`);
            return await this.respond(reply, () => this.runCommand(adapter, policy, event.repo, number, event.user,
              { verb: 'apply', project: event.project, destroy: false, override: false, targets: [], extraArgs: [] }, reply));
          }
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
    if (this.commentMode(ctx) === 'update') return this.plans(ctx, allowedTargets, ctx.pr.author, {}, notes);
    if (!targets.length) return;
    const reply = new Reply(adapter, repo, number, this.spinner(policy));
    await reply.start(`Planning ${targets.length} project${targets.length === 1 ? '' : 's'} for \`${ctx.pr.headSha.slice(0, 7)}\`…`);
    await this.respond(reply, () => this.plans(ctx, allowedTargets, ctx.pr.author, {}, notes, reply));
  }

  private async closed(repo: Repo, number: number) {
    const released = this.deps.store.releasePrLocks(this.repoKey(repo), number);
    this.deps.store.forgetPrComments(this.repoKey(repo), number);
    this.deps.store.discardPlans(this.repoKey(repo), number);
    rmSync(this.workDir(repo, number), { recursive: true, force: true });
    rmSync(this.planDir(repo, number), { recursive: true, force: true });
    log.info('PR closed; cleaned up', { repo: repo.fullName, pr: number, released });
  }

  private ack(policy: RepoPolicy) { return policy.ack_reaction ?? this.deps.config.ackReaction; }

  // The spinner for the "Running…" reply, or null when that reply is off or GitHub
  // couldn't load the image (no public https address).
  private spinner(policy: RepoPolicy) {
    return (policy.progress_reply ?? this.deps.config.progressReply) ? this.deps.config.spinnerUrl : null;
  }

  // Runs a command and always ends with its reply, even when it fails.
  private async respond(reply: Reply, work: () => Promise<unknown>) {
    try {
      await work();
    } catch (err) {
      log.error('command failed', { err });
      reply.say(`⚠️ tfv hit an error: ${(err as Error).message}`);
    }
    await reply.send();
  }

  private async onComment(adapter: VcsAdapter, policy: RepoPolicy, repo: Repo, number: number, author: string, body: string, commentId: string) {
    const parsed = parseCommand(body, this.deps.config.commandNames);
    if (!parsed) return;
    // Acknowledge at once: a reaction on the command (👀 by default) and a
    // spinning "Running…" reply under it that turns into the result.
    const ack = this.ack(policy);
    if (ack !== 'none') await adapter.react(repo, number, commentId, ack);
    const reply = new Reply(adapter, repo, number, this.spinner(policy));
    const line = body.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
    if (parsed.ok && parsed.command.verb !== 'help') await reply.start(`Running \`${line.slice(0, 120)}\` for ${author}…`);
    if (!parsed.ok) {
      reply.say(`❌ ${parsed.error}`);
      await reply.send();
      return;
    }
    await this.respond(reply, () => this.runCommand(adapter, policy, repo, number, author, parsed.command, reply));
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

  private async runCommand(adapter: VcsAdapter, policy: RepoPolicy, repo: Repo, number: number, user: string, cmd: Command, reply: Reply) {
    const name = this.deps.config.commandNames[0];
    if (cmd.verb === 'help') {
      const oneAtATime = this.deps.config.requireApplyProject || policy.require_apply_project === true;
      return reply.say(helpText(name, oneAtATime));
    }
    if (cmd.targets.length && policy.allow_targets === false) {
      return reply.say('❌ Targeted plans are turned off for this repo (`allow_targets` in repos.yaml).');
    }
    if (cmd.extraArgs.length && !policy.allow_extra_args) {
      return reply.say('❌ Extra arguments are turned off for this repo (`allow_extra_args` in repos.yaml).');
    }

    const ctx = await this.context(adapter, policy, repo, number);
    if (!ctx.pr.open) return reply.say('❌ This PR is closed.');

    if (cmd.verb === 'unlock') return this.unlock(ctx, user, cmd, reply);
    if (cmd.tool) return this.toolCommand(ctx, user, cmd, reply);

    if (cmd.verb === 'plan') {
      const changed = affectedProjects(ctx.projects, await adapter.changedFiles(repo, number));
      const targets = this.select(ctx, cmd, changed);
      if (typeof targets === 'string') return reply.say(`❌ ${targets}`);
      if (!targets.length) return reply.say('No projects changed in this PR. Use `-p <project>` to plan one anyway.');
      const notes = new Map<string, string>();
      const allowed: Project[] = [];
      for (const p of targets) {
        const d = await this.allowed(ctx, 'plan', user, p);
        if (d.allowed) allowed.push(p); else notes.set(p.name, `🚫 ${d.reason}`);
      }
      await this.plans(ctx, allowed, user, { destroy: cmd.destroy, targets: cmd.targets, extraArgs: cmd.extraArgs, refreshOnly: cmd.refreshOnly, replace: cmd.replace }, notes, reply);
      if (this.commentMode(ctx) === 'update' || !allowed.length) reply.say(this.planOutcome(ctx, targets, notes));
      return;
    }

    return this.applyCommand(ctx, user, cmd, reply);
  }

  // ---- Terraform commands (state list, import, state rm, ...) ----

  private async toolCommand(ctx: PrContext, user: string, cmd: Command, reply: Reply) {
    const name = this.deps.config.commandNames[0];
    const tool = cmd.tool!;
    const text = `${name} ${tool}${cmd.project ? ` -p ${cmd.project}` : cmd.dir ? ` -d ${cmd.dir}` : ''}${cmd.workspace ? ` -w ${cmd.workspace}` : ''}${cmd.args?.length ? ` ${cmd.args.join(' ')}` : ''}`;
    const picked = this.select(ctx, cmd, []);
    if (typeof picked === 'string') return reply.say(`❌ ${picked}`);
    if (picked.length !== 1) return reply.say(`❌ \`${name} ${tool}\` runs on one project; ${picked.length} match. Add \`-w <workspace>\` to pick one.`);
    const project = picked[0];
    const action = TOOL_ACTION[tool];
    const changes = EDITS_STATE.includes(tool);

    if (changes && ctx.policy.allow_state_changes === false) {
      return reply.say(`❌ Editing the state from PR comments is turned off for this repo (\`allow_state_changes\` in repos.yaml).`);
    }
    const d = await this.allowed(ctx, action, user, project);
    if (!d.allowed) return reply.say(`🚫 \`${text}\`: ${d.reason}`);
    if (changes) {
      // Changing the state outside a reviewed plan needs what an apply needs:
      // the project's approvals and PR requirements.
      if (!ctx.pr.open) return reply.say('❌ This PR is closed.');
      const blockers = await applyBlockers(project, this.rules(ctx, project), ctx.pr, await this.approvers(ctx), ctx.lookup);
      if (blockers.length) {
        this.deps.store.audit({ repo: ctx.repoKey, pr: ctx.pr.number, user, action, project: project.name, allowed: false, reason: `blocked: ${blockers.join('; ')}` });
        return reply.say(`🔒 \`${text}\` needs ${blockers.join('; ')}`);
      }
    }
    // Changing the state takes the project's lock, like an apply.
    if (changes) {
      const lock = this.deps.store.acquireLock(ctx.repoKey, project.name, project.workspace, ctx.pr.number, user);
      if (!lock.ok) return reply.say(`🔒 \`${project.name}\` is locked by #${lock.heldBy.pr} (${lock.heldBy.user}); apply or unlock it there first.`);
    }

    const r = await this.sched.use(`${ctx.repoKey}#${ctx.pr.number}`, async () => {
      const tools = await this.tools(ctx, project);
      return runTool({
        root: ctx.root, project, tools, planPath: this.planPath(ctx, project), env: this.env(ctx, project, user), timeoutMs: this.deps.config.runTimeoutMs,
      }, toolArgs(cmd));
    });
    this.deps.store.audit({
      repo: ctx.repoKey, pr: ctx.pr.number, user, action: tool, project: project.name, allowed: true,
      reason: `${r.ok ? 'ran' : 'failed'}: ${text}`,
    });

    // fmt reports unformatted files with exit code 3: that's a finding, not a failure.
    const fmtFindings = tool === 'fmt' && r.code === 3;
    const icon = r.ok ? '✅' : fmtFindings ? '📝' : '❌';
    const empty = r.output.split('\n').length <= 1;
    const out = [`${icon} \`${text}\``, ''];
    if (fmtFindings) out.push('Some files need `terraform fmt`:', '');
    if (!empty) out.push(fence(tail(r.output, ctx.adapter.commentLimit - 3000)));
    else if (r.ok) out.push(tool === 'state list' || tool === 'output' ? '_Nothing in the state._' : '_No output._');
    reply.say(out.join('\n'));

    // The old plan was made against the old state: plan again (plan only).
    if (r.ok && changes) {
      reply.say(`🔁 The state was edited directly, so \`${project.name}\` is planned again. Review it before applying.`);
      await this.plans(ctx, [project], user, {}, new Map(), reply);
    }
  }

  // ---- plan ----

  // "✅ Planned 2 projects" with each project's result and a link to the summary.
  private planOutcome(ctx: PrContext, targets: Project[], notes: Map<string, string>): string {
    const runs = new Map(this.deps.store.latestRuns(ctx.repoKey, ctx.pr.number, 'plan')
      .filter(r => r.headSha === ctx.pr.headSha).map(r => [r.project, r]));
    const lines = targets.map(p => {
      const note = notes.get(p.name);
      if (note) return `- \`${p.name}\`: ${note}`;
      const r = runs.get(p.name);
      if (!r) return `- \`${p.name}\`: not planned`;
      if (r.status === 'failed') return `- ❌ \`${p.name}\`: plan failed`;
      return `- ${r.destroys ? '⚠️' : r.hasChanges ? '📝' : '✅'} \`${p.name}\`: ${sizeText(r.summary)}${r.targets.length ? ' (targeted)' : ''}`;
    });
    const failed = targets.some(p => runs.get(p.name)?.status === 'failed' || notes.has(p.name));
    const head = `${failed ? '⚠️' : '✅'} **Planned ${targets.length} project${targets.length === 1 ? '' : 's'}**${ctx.summaryUrl ? ` · [see the summary](${ctx.summaryUrl})` : ''}`;
    return [head, ...lines].join('\n');
  }

  private async plans(ctx: PrContext, targets: Project[], user: string, opts: PlanOpts, notes: Map<string, string>, reply?: Reply) {
    const { store } = this.deps;
    await Promise.all(targets.map(project => this.sched.use(`${ctx.repoKey}#${ctx.pr.number}`, async () => {
      // A newer commit was pushed while this waited: its own plans are on the way.
      if (this.outdated(ctx)) { notes.set(project.name, '⏭️ skipped: a newer commit was pushed'); return; }
      const lock = store.acquireLock(ctx.repoKey, project.name, project.workspace, ctx.pr.number, user);
      if (!lock.ok) {
        notes.set(project.name, `🔒 locked by #${lock.heldBy.pr} (${lock.heldBy.user}); apply or unlock it there first`);
        return;
      }
      await this.planProject(ctx, project, user, opts);
    })));
    // Nothing to report for a commit that's already been replaced.
    if (this.outdated(ctx)) return;
    await this.refreshComment(ctx, notes, new Set([...targets.map(t => t.name), ...notes.keys()]), reply);
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

  private async planProject(ctx: PrContext, project: Project, user: string, opts: PlanOpts) {
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
      let policy: PolicyResult | null = null;
      const pol = this.policyFor(ctx, project);
      if (r.ok && r.plan && pol.mode !== 'off') {
        const cwd = project.dir === '.' ? ctx.root : join(ctx.root, project.dir);
        policy = {
          mode: pol.mode,
          findings: [
            ...evaluateRules(r.plan, pol.rules ?? [], project),
            ...(r.planJsonPath ? await runCommands(pol.commands ?? [], r.planJsonPath, cwd, this.env(ctx, project, user), project) : []),
          ],
        };
      }
      // Terragrunt: did this plan use a dependency's mock outputs?
      let mocks: string[] = [];
      const tgFile = join(ctx.root, project.dir, 'terragrunt.hcl');
      if (project.engine === 'terragrunt' && existsSync(tgFile)) {
        const deps = terragruntDependencies(ctx.root, project.dir, readFileSync(tgFile, 'utf-8'));
        // Planned: which dependencies were mocked. Failed: which ones it needed but couldn't read.
        mocks = (r.ok ? mockedDependencies(project.dir, deps, r.output, r.plan) : unappliedDependencies(project.dir, deps, r.output))
          .map(dir => ctx.projects.find(p => p.dir === dir)?.name ?? dir);
      }
      const lock = join(ctx.root, project.dir, '.terraform.lock.hcl');
      const providers = providersOf(existsSync(lock) ? readFileSync(lock, 'utf-8') : null, r.plan);
      store.finishRun(runId, {
        status: r.ok ? 'success' : 'failed', engine, summary: r.summary ? JSON.stringify(r.summary) : null,
        output: r.output, planPath: r.ok ? planPath : null, hasChanges: r.hasChanges, destroys,
        policy: policy ? JSON.stringify(policy) : null, mocks, providers, usage: r.usage ?? null,
      });
      if (policy?.findings.length) store.saveFindings(store.getRun(runId)!, policy.mode, policy.findings);
    } catch (err) {
      store.finishRun(runId, { status: 'failed', engine, output: `tfv could not run this project: ${(err as Error).message}` });
    }
    metrics.observeRun('plan', store.getRun(runId)!.status, Date.now() - started);
    await this.publishCheck(ctx, project, store.getRun(runId)!);
  }

  // ---- rules that depend on the plan ----

  // Server policies plus the repo's; the repo can only make the mode stricter.
  private policyFor(ctx: PrContext, _project: Project): PolicyConfig & { mode: NonNullable<PolicyConfig['mode']> } {
    const server = this.deps.config.policies ?? {};
    const repo = ctx.policy.policies ?? {};
    return {
      mode: stricter(server.mode, repo.mode),
      override: repo.override ?? server.override ?? [],
      rules: [...(server.rules ?? []), ...(repo.rules ?? [])],
      commands: [...(server.commands ?? []), ...(repo.commands ?? [])],
    };
  }

  // Two-person rule: on for the repo, or for a matching project rule (server or repo config).
  private twoPerson(ctx: PrContext, project: Project): boolean {
    if (ctx.policy.two_person_rule) return true;
    const r = this.rules(ctx, project);
    return !!(r.server?.two_person_rule || r.repo.some(x => x.two_person_rule));
  }

  private policyOf(plan: Run | undefined): PolicyResult | null {
    return plan?.policy ? JSON.parse(plan.policy) as PolicyResult : null;
  }

  // Everything that stops a project's apply right now. With `override`,
  // the overridable ones (enforced policy findings) are skipped.
  // Dependency problems that make a plan unsafe to apply (never overridable):
  // it used mock outputs, or a dependency was applied after it was made.
  private dependencyBlockers(ctx: PrContext, project: Project, plan: Run): string[] {
    const name = this.deps.config.commandNames[0];
    const list = (xs: string[]) => xs.map(x => `\`${x}\``).join(', ');
    if (plan.mocks.length) {
      return [`planned with mock outputs from ${list(plan.mocks)}: apply ${list(plan.mocks)} first (${plan.mocks.map(m => `\`${name} apply -p ${m}\``).join(', ')}); this project is then re-planned with the real outputs`];
    }
    const applies = this.deps.store.latestRuns(ctx.repoKey, ctx.pr.number, 'apply');
    const newer = ctx.projects
      .filter(q => q !== project && project.deps.includes(q.dir))
      .filter(q => applies.some(a => a.project === q.name && a.status === 'success' && a.id > plan.id))
      .map(q => q.name);
    return newer.length ? [`${list(newer)} applied after this plan: re-plan this project first (\`${name} plan -p ${project.name}\`)`] : [];
  }

  private async blockers(ctx: PrContext, project: Project, plan: Run, approvers: string[], override = false): Promise<string[]> {
    const out = [...this.dependencyBlockers(ctx, project, plan), ...await applyBlockers(project, this.rules(ctx, project), ctx.pr, approvers, ctx.lookup)];
    const pol = this.policyOf(plan);
    if (!override && pol?.mode === 'enforce' && pol.findings.length) {
      const rules = [...new Set(pol.findings.map(f => f.rule))];
      out.push(`${pol.findings.length} policy finding${pol.findings.length === 1 ? '' : 's'} (${rules.slice(0, 3).join(', ')}${rules.length > 3 ? ', …' : ''})`);
    }
    return out;
  }

  // ---- apply ----

  private async approvers(ctx: PrContext) {
    return currentApprovers(await ctx.adapter.reviews(ctx.repo, ctx.pr.number), ctx.pr.author, ctx.pr.headSha);
  }

  // Groups projects into waves: each wave only depends on earlier waves.
  private waves(projects: Project[]): Project[][] {
    const level = new Map<string, number>();
    const depth = (p: Project, stack: Set<string>): number => {
      if (level.has(p.name)) return level.get(p.name)!;
      if (stack.has(p.name)) return 0; // a cycle: treat as independent
      stack.add(p.name);
      const deps = projects.filter(q => q !== p && p.deps.includes(q.dir));
      const d = deps.length ? Math.max(...deps.map(q => depth(q, stack) + 1)) : 0;
      level.set(p.name, d);
      return d;
    };
    projects.forEach(p => depth(p, new Set()));
    const out: Project[][] = [];
    for (const p of projects) (out[level.get(p.name)!] ??= []).push(p);
    return out.filter(Boolean);
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

  private async applyCommand(ctx: PrContext, user: string, cmd: Command, reply: Reply) {
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
      return reply.say([
        `This server applies one project at a time, so \`${name} apply\` on its own is turned off.`,
        planned.length
          ? ['Apply each project with:', ...planned.flatMap(p => [...cmdBlock(`${name} apply -p ${p.name}`), ''])].join('\n').trim()
          : 'No project has a plan ready to apply yet.',
      ].join('\n\n'));
    }

    const selected = this.select(ctx, cmd, planned);
    if (typeof selected === 'string') return reply.say(`❌ ${selected}`);
    if (!selected.length) {
      return reply.say('Nothing to apply: no project has a successful plan with changes at the current commit. Run `tfv plan` first.');
    }

    const approvers = await this.approvers(ctx);
    const notes = new Map<string, string>();
    const denied: string[] = [];
    const attempted = new Set<string>();
    const approved: { project: Project; plan: Run }[] = [];
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

      if (this.twoPerson(ctx, project) && user.toLowerCase() === ctx.pr.author.toLowerCase()) {
        this.deps.store.audit({ repo: ctx.repoKey, pr: ctx.pr.number, user, action: 'apply', project: project.name, allowed: false, reason: 'two-person rule: the PR author may not apply' });
        denied.push(`- \`${project.name}\`: two-person rule: someone other than the PR author (${ctx.pr.author}) must apply`);
        continue;
      }

      let override = false;
      if (cmd.override) {
        const who = this.policyFor(ctx, project).override ?? [];
        for (const p of who) if (await matchesPrincipal(p, user, project, ctx.lookup)) { override = true; break; }
        this.deps.store.audit({
          repo: ctx.repoKey, pr: ctx.pr.number, user, action: 'override', project: project.name, allowed: override,
          reason: override ? 'applied despite enforced policy findings' : `--override needs ${who.join(' or ') || 'an override list in repos.yaml'}`,
        });
        if (!override) {
          denied.push(`- \`${project.name}\`: \`--override\` needs ${who.join(' or ') || 'an `override` list under policies in repos.yaml'}`);
          continue;
        }
      }

      const blockers = await this.blockers(ctx, project, plan, approvers, override);
      if (blockers.length) {
        denied.push(`- \`${project.name}\`: ${blockers.join('; ')}`);
        continue;
      }
      approved.push({ project, plan });
    }

    // Apply in dependency waves: a project starts once everything it depends on
    // has applied; projects in the same wave run in parallel.
    const failed = new Set<string>();
    const held = new Set<string>();    // re-planned or waiting on one: applies in a later command
    const appliedNow = new Set<string>();
    const replanned: string[] = [];
    for (const wave of this.waves(approved.map(a => a.project))) {
      await Promise.all(wave.map(async project => {
        const blockedBy = approved.map(a => a.project).filter(q => project.deps.includes(q.dir) && failed.has(q.name));
        if (blockedBy.length) {
          notes.set(project.name, `skipped: ${blockedBy.map(q => `\`${q.name}\``).join(', ')} failed to apply first`);
          failed.add(project.name);
          return;
        }
        const waitingOn = approved.map(a => a.project).filter(q => project.deps.includes(q.dir) && held.has(q.name));
        if (waitingOn.length) {
          notes.set(project.name, `waits for ${waitingOn.map(q => `\`${q.name}\``).join(', ')} (re-planned); apply it after that`);
          held.add(project.name);
          return;
        }
        // Its plan used the dependency's old (or mock) outputs: plan again with the
        // real ones and let people review that, instead of applying a stale plan.
        const changedDeps = approved.map(a => a.project).filter(q => project.deps.includes(q.dir) && appliedNow.has(q.name));
        if (changedDeps.length) {
          await this.sched.use(`${ctx.repoKey}#${ctx.pr.number}`, () => this.planProject(ctx, project, user, {}));
          replanned.push(project.name);
          notes.set(project.name, `🔁 re-planned after ${changedDeps.map(q => `\`${q.name}\``).join(', ')} applied (its outputs feed this project). Review the new plan, then comment \`${this.deps.config.commandNames[0]} apply -p ${project.name}\``);
          held.add(project.name); // its own dependents wait too
          return;
        }
        const { plan } = approved.find(a => a.project.name === project.name)!;
        attempted.add(project.name);
        await this.sched.use(`${ctx.repoKey}#${ctx.pr.number}`, () => this.applyProject(ctx, project, user, plan));
        if (this.deps.store.latestRuns(ctx.repoKey, ctx.pr.number, 'apply').find(r => r.project === project.name)?.status !== 'success') failed.add(project.name);
        else appliedNow.add(project.name);
      }));
    }

    // Anything in this PR that depends on what was just applied is planned again
    // (plan only, never applied), so its next apply uses the real outputs.
    const appliedDirs = ctx.projects.filter(p => appliedNow.has(p.name)).map(p => p.dir);
    const headPlans = new Set(this.deps.store.latestRuns(ctx.repoKey, ctx.pr.number, 'plan').filter(r => r.headSha === ctx.pr.headSha).map(r => r.project));
    const dependents = ctx.projects.filter(p => !appliedNow.has(p.name) && !replanned.includes(p.name)
      && headPlans.has(p.name) && p.deps.some(d => appliedDirs.includes(d)));
    await Promise.all(dependents.map(p => this.sched.use(`${ctx.repoKey}#${ctx.pr.number}`, async () => {
      await this.planProject(ctx, p, user, {});
      replanned.push(p.name);
      const from = ctx.projects.filter(q => appliedNow.has(q.name) && p.deps.includes(q.dir)).map(q => `\`${q.name}\``).join(', ');
      notes.set(p.name, `🔁 re-planned with the new outputs of ${from}. Review it, then comment \`${this.deps.config.commandNames[0]} apply -p ${p.name}\``);
    })));

    const applied = this.deps.store.latestRuns(ctx.repoKey, ctx.pr.number, 'apply')
      .filter(r => r.headSha === ctx.pr.headSha && attempted.has(r.project));
    const done = applied.filter(r => r.status === 'success').map(r => `- ✅ \`${r.project}\`: applied`);
    const broke = applied.filter(r => r.status === 'failed').map(r => `- ❌ \`${r.project}\`: apply failed (see the summary for the log)`);
    const link = ctx.summaryUrl ? ` · [see the summary](${ctx.summaryUrl})` : '';
    if (this.commentMode(ctx) === 'update') {
      await this.refreshComment(ctx, notes);
      if (done.length || broke.length) reply.say([`${broke.length ? '⚠️' : '✅'} **Applied ${done.length} of ${applied.length}**${ctx.summaryUrl ? ` · [see the summary](${ctx.summaryUrl})` : link}`, ...done, ...broke].join('\n'));
    } else {
      // The apply's own report: what was created, changed and destroyed, outputs, the apply log.
      if (applied.length) {
        const planOf = new Map(this.deps.store.latestRuns(ctx.repoKey, ctx.pr.number, 'plan').filter(r => r.headSha === ctx.pr.headSha).map(r => [r.project, r]));
        reply.say(renderApplyReport({
          marker: '<!-- tfv:apply -->', headSha: ctx.pr.headSha, command: this.deps.config.commandNames[0],
          applies: applied.map(r => ({ name: r.project, apply: r, plan: plans.get(`${r.project}::${r.workspace}`) ?? planOf.get(r.project), dir: ctx.projects.find(p => p.name === r.project)?.dir })),
          links: this.commentLinks(ctx), limit: ctx.adapter.commentLimit, dashboardUrl: this.deps.config.publicUrl,
        }));
      }
      // Units re-planned with new dependency outputs: their (new) plan, to review.
      if (replanned.length) await this.refreshComment(ctx, new Map(), new Set(replanned), reply);
    }
    if (denied.length) reply.say(`**Not applied:**\n${denied.join('\n')}`);
    for (const [project, note] of notes) reply.say(`- \`${project}\`: ${note}`);

    // The commands to type next, each in a block with a copy button.
    const name = this.deps.config.commandNames[0];
    const next: string[] = [];
    for (const project of selected) {
      const plan = plans.get(`${project.name}::${project.workspace}`);
      for (const m of plan?.mocks ?? []) next.push(`${name} apply -p ${m}`);
    }
    for (const p of replanned) next.push(`${name} apply -p ${p}`);
    const unique = [...new Set(next)].filter(c => !attempted.has(c.slice(`${name} apply -p `.length)) || replanned.includes(c.slice(`${name} apply -p `.length)));
    if (unique.length) reply.say(['**Next, comment:**', ...unique.flatMap(c => [...cmdBlock(c), ''])].join('\n').trim());
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
      // The counts are saved now, so the Metrics page never has to read logs.
      store.finishRun(runId, { status: r.ok ? 'success' : 'failed', engine, output: r.output, summary: plan.summary, usage: r.usage ?? null, applied: parseApplyResult(r.output) });
    } catch (err) {
      store.finishRun(runId, { status: 'failed', engine, output: `tfv could not apply this project: ${(err as Error).message}` });
    }
    metrics.observeRun('apply', store.getRun(runId)!.status, Date.now() - started);
    await this.publishCheck(ctx, project, store.getRun(runId)!);
  }

  // ---- unlock ----

  private async unlock(ctx: PrContext, user: string, cmd: Command, reply: Reply) {
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
    reply.say(released.length
      ? `🔓 Unlocked ${released.map(p => `\`${p}\``).join(', ')} and discarded the plans. Run \`tfv plan\` to plan again.`
      : 'This PR holds no locks you can release.');
  }

  // A lock released from the dashboard: drop that project's plan (it was made under the
  // lock) and tell the PR, so its people know why they must plan again.
  async dashboardUnlock(adapter: VcsAdapter | undefined, lock: { repo: string; pr: number; project: string; workspace: string; user: string }, by: { name: string; via: string }): Promise<boolean> {
    this.deps.store.discardPlans(lock.repo, lock.pr, lock.project);
    if (!adapter) return false;
    const [host, owner, ...rest] = lock.repo.split('/');
    const name = rest.join('/');
    const repo: Repo = { platform: adapter.platform, host, owner, name, fullName: `${owner}/${name}`, cloneUrl: '' };
    const cmd = this.deps.config.commandNames[0];
    const ws = lock.workspace !== 'default' ? ` (workspace \`${lock.workspace}\`)` : '';
    try {
      await this.recording(adapter).comment(repo, lock.pr, [
        `🔓 **\`${lock.project}\`${ws} was unlocked from the tfv dashboard** by ${by.name} (${by.via}).`,
        '',
        `Its plan was discarded, and another PR may now plan and apply it. To continue here, plan it again:`,
        ...cmdBlock(`${cmd} plan -p ${lock.project}`),
      ].join('\n'));
      return true;
    } catch (err) {
      log.warn('could not post the dashboard unlock to the PR', { repo: lock.repo, pr: lock.pr, err: (err as Error).message });
      return false;
    }
  }

  // ---- output ----

  private async check(ctx: PrContext, check: Parameters<VcsAdapter['setCheck']>[1]) {
    if (!ctx.adapter.supportsChecks) return;
    const url = await ctx.adapter.setCheck(ctx.repo, { ...check, detailsUrl: `${this.deps.config.publicUrl}/` })
      .catch(err => { log.warn('check update failed', { err }); return null; });
    if (url && check.externalId) this.checkUrls.set(`${ctx.repoKey}#${ctx.pr.number}#${check.externalId}`, url);
  }

  private async publishCheck(ctx: PrContext, project: Project, run: Run) {
    if (!ctx.adapter.supportsChecks) return;
    let blockers: string[] | undefined;
    if (run.kind === 'plan' && run.status === 'success' && run.hasChanges) {
      blockers = await this.blockers(ctx, project, run, await this.approvers(ctx));
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

  // Links and avatars for comments on this PR's platform.
  private commentLinks(ctx: PrContext): CommentLinks {
    const l = repoLinks(ctx.repoKey, platformForHost(ctx.repo.host, { [ctx.repo.host]: ctx.repo.platform }));
    return {
      commit: sha => l.commit(sha),
      tree: (sha, dir) => l.tree(sha, dir),
      user: login => l.user(login),
      avatar: login => (avatarSource(ctx.repo.platform, ctx.repo.host, login) ? `https://${ctx.repo.host}/${encodeURIComponent(login)}.png?size=36` : null),
      run: id => `${this.deps.config.publicUrl}/#runs/${id}`,
    };
  }

  private commentMode(ctx: PrContext) { return ctx.policy.comment_mode ?? this.deps.config.commentMode; }

  // Renders the plan report. "new" mode: only this command's projects, as the
  // command's own reply (a new comment). "update" mode: every project, in one
  // comment at the top that is edited in place.
  private async refreshComment(ctx: PrContext, notes: Map<string, string>, only?: Set<string>, reply?: Reply) {
    const { store, config } = this.deps;
    const head = ctx.pr.headSha;
    const asReply = this.commentMode(ctx) === 'new' && reply;
    const plans = store.latestRuns(ctx.repoKey, ctx.pr.number, 'plan')
      .filter(r => r.headSha === head && (!asReply || !only || only.has(r.project)));
    const applies = new Map(store.latestRuns(ctx.repoKey, ctx.pr.number, 'apply').map(r => [`${r.project}::${r.workspace}`, r]));
    const approvers = plans.some(p => p.status === 'success' && p.hasChanges) ? await this.approvers(ctx) : [];

    const views: ProjectView[] = [];
    for (const plan of plans) {
      const project = ctx.projects.find(p => p.name === plan.project) ?? { name: plan.project, dir: plan.project, deps: [] } as unknown as Project;
      const view: ProjectView = {
        name: plan.project, plan, apply: applies.get(`${plan.project}::${plan.workspace}`), note: notes.get(plan.project), dir: project.dir,
        checkUrl: this.checkUrls.get(`${ctx.repoKey}#${ctx.pr.number}#${plan.project}`) ?? null,
      };
      if (plan.status === 'success' && plan.hasChanges) {
        view.blockers = await this.blockers(ctx, project, plan, approvers);
        if (this.twoPerson(ctx, project)) view.applyBy = `someone other than ${ctx.pr.author}`;
      }
      views.push(view);
    }
    for (const [name, note] of notes) if (!views.some(v => v.name === name)) views.push({ name, note });
    if (!views.length) return;
    if (asReply && plans.length === 0) {
      // Nothing ran (locked or not allowed): say why, in the reply.
      reply.say([...notes].map(([name, note]) => `- \`${name}\`: ${note}`).join('\n'));
      return;
    }
    views.sort((a, b) => a.name.localeCompare(b.name));

    const body = renderComment({
      marker: asReply ? '<!-- tfv:report -->' : MARKER, headSha: head, command: config.commandNames[0], projects: views,
      dashboardUrl: config.publicUrl, limit: ctx.adapter.commentLimit, warnings: ctx.warnings,
      oneProjectPerApply: this.oneAtATime(ctx),
      approvers,
      links: this.commentLinks(ctx),
    });
    if (asReply) {
      reply.say(body);
      return;
    }
    const saved = await ctx.adapter.upsertComment(ctx.repo, ctx.pr.number, MARKER, body, store.commentId(ctx.repoKey, ctx.pr.number));
    if (saved) store.saveCommentId(ctx.repoKey, ctx.pr.number, saved.id);
    ctx.summaryUrl = saved?.url ?? null;
  }
}
