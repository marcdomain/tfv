// GitHub (github.com and GitHub Enterprise Server) via a GitHub App.
// No SDK: App JWTs are signed with node:crypto and the REST API is plain fetch.
import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import type {
  CheckRun, CloneAuth, Permission, PullRequest, PullRequestState, Reaction, Repo, Review, VcsAdapter, VcsEvent,
} from './types.ts';
import type { GitHubConfig } from '../config.ts';
import { addSecret, log } from '../log.ts';

type Headers = Record<string, string | string[] | undefined>;
const header = (h: Headers, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

export const appJwt = (appId: string, privateKey: string, now = Math.floor(Date.now() / 1000)): string => {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // iat is backdated 60s for clock drift; GitHub allows at most 10 minutes.
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(signer.sign(privateKey))}`;
};

export const verifySignature = (secret: string, rawBody: Buffer, signature: string | undefined): boolean => {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const got = Buffer.from(signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
};

class TtlCache<V> {
  private map = new Map<string, { value: V; until: number }>();
  private ttlMs: number;
  constructor(ttlMs: number) { this.ttlMs = ttlMs; }
  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.map.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = await load();
    this.map.set(key, { value, until: Date.now() + this.ttlMs });
    return value;
  }
}

export class GitHubAdapter implements VcsAdapter {
  readonly platform = 'github' as const;
  readonly commentLimit = 65000;
  readonly supportsChecks = true;

  private tokens = new Map<number, { token: string; expires: number }>();
  // RBAC lookups are cached briefly (plan: 5 minutes).
  private permCache = new TtlCache<Permission>(5 * 60_000);
  private teamCache = new TtlCache<boolean>(5 * 60_000);
  private ownersCache = new TtlCache<string | null>(60_000);

  private cfg: GitHubConfig;
  private fetchImpl: typeof fetch;

  constructor(cfg: GitHubConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    addSecret(cfg.webhookSecret);
  }

  // ---- auth ----

  // Which installation of the App covers a repo. Webhooks carry it; for work that
  // starts elsewhere (the dashboard, schedules) it's looked up once and remembered.
  private installationIds = new Map<string, number>();
  private async installationFor(repo: Repo): Promise<number> {
    if (repo.installationId) {
      this.installationIds.set(repo.fullName.toLowerCase(), repo.installationId);
      return repo.installationId;
    }
    const known = this.installationIds.get(repo.fullName.toLowerCase());
    if (known) return known;
    const res = await this.fetchImpl(`${this.cfg.apiUrl}/repos/${repo.fullName}/installation`, {
      headers: { Authorization: `Bearer ${appJwt(this.cfg.appId, this.cfg.privateKey)}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tfv-server' },
    });
    if (!res.ok) throw new Error(`no GitHub App installation for ${repo.fullName} (HTTP ${res.status}); is the App installed on it?`);
    const id = (await res.json() as { id: number }).id;
    this.installationIds.set(repo.fullName.toLowerCase(), id);
    return id;
  }

  // A token for public GitHub downloads (OpenTofu, Terragrunt): any installation of
  // the App will do. Only for github.com; a GitHub Enterprise App can't sign in there.
  async downloadToken(): Promise<string | null> {
    if (this.cfg.host !== 'github.com') return null;
    const res = await this.fetchImpl(`${this.cfg.apiUrl}/app/installations?per_page=1`, {
      headers: { Authorization: `Bearer ${appJwt(this.cfg.appId, this.cfg.privateKey)}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tfv-server' },
    });
    if (!res.ok) return null;
    const [first] = await res.json() as { id: number; account?: { login?: string } }[];
    if (!first) return null;
    return this.installationToken({ platform: 'github', host: this.cfg.host, owner: first.account?.login ?? '', name: '', fullName: `installation-${first.id}`, cloneUrl: '', installationId: first.id });
  }

  private async installationToken(repo: Repo): Promise<string> {
    const id = await this.installationFor(repo);
    const cached = this.tokens.get(id);
    if (cached && cached.expires - 5 * 60_000 > Date.now()) return cached.token;
    const res = await this.fetchImpl(`${this.cfg.apiUrl}/app/installations/${id}/access_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${appJwt(this.cfg.appId, this.cfg.privateKey)}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tfv-server' },
    });
    if (!res.ok) throw new Error(`GitHub App token request failed: HTTP ${res.status}`);
    const data = await res.json() as { token: string; expires_at: string };
    addSecret(data.token);
    this.tokens.set(id, { token: data.token, expires: Date.parse(data.expires_at) });
    return data.token;
  }

  private async api<T = any>(repo: Repo, method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; data: T; next: string | null }> {
    const token = await this.installationToken(repo);
    const url = path.startsWith('http') ? path : `${this.cfg.apiUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tfv-server',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1] ?? null;
    return { status: res.status, data: (text ? JSON.parse(text) : null) as T, next };
  }

  private async paginate<T>(repo: Repo, path: string, max = 10000): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (next && out.length < max) {
      const r: { data: T[]; next: string | null } = await this.api<T[]>(repo, 'GET', next);
      out.push(...r.data);
      next = r.next;
    }
    return out;
  }

  // ---- webhooks ----

  verify(headers: Headers, rawBody: Buffer): boolean {
    return verifySignature(this.cfg.webhookSecret, rawBody, header(headers, 'x-hub-signature-256'));
  }

  private repoFrom(payload: any): Repo {
    return this.toRepo(payload.repository, payload.installation?.id);
  }

  private toRepo(r: any, installationId?: number): Repo {
    return {
      platform: 'github',
      host: this.cfg.host,
      owner: r.owner.login,
      name: r.name,
      fullName: r.full_name,
      cloneUrl: r.clone_url,
      installationId,
      defaultBranch: r.default_branch,
    };
  }

  async listRepos(): Promise<Repo[]> {
    const headers = { Authorization: `Bearer ${appJwt(this.cfg.appId, this.cfg.privateKey)}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tfv-server' };
    const res = await this.fetchImpl(`${this.cfg.apiUrl}/app/installations?per_page=100`, { headers });
    if (!res.ok) throw new Error(`GitHub: listing installations failed (HTTP ${res.status})`);
    const installations = await res.json() as { id: number }[];
    const repos: Repo[] = [];
    for (const inst of installations) {
      const probe = { installationId: inst.id } as Repo;
      let next: string | null = '/installation/repositories?per_page=100';
      while (next) {
        const page: { data: { repositories: any[] }; next: string | null } = await this.api(probe, 'GET', next);
        repos.push(...page.data.repositories.map(r => this.toRepo(r, inst.id)));
        next = page.next;
      }
    }
    return repos;
  }

  private prFrom(pr: any): PullRequest {
    return {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user.login,
      headSha: pr.head.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      draft: !!pr.draft,
      fromFork: pr.head.repo?.full_name !== pr.base.repo?.full_name,
    };
  }

  parse(headers: Headers, body: any): VcsEvent {
    const event = header(headers, 'x-github-event');
    if (!body?.repository) return { kind: 'ignored', reason: `${event} without a repository` };
    const repo = this.repoFrom(body);

    if (event === 'pull_request') {
      const pr = this.prFrom(body.pull_request);
      switch (body.action) {
        case 'opened': case 'reopened': case 'ready_for_review': return { kind: 'pr_opened', repo, pr };
        case 'synchronize': return { kind: 'pr_updated', repo, pr };
        case 'closed': return { kind: 'pr_closed', repo, pr, merged: !!body.pull_request.merged };
        default: return { kind: 'ignored', reason: `pull_request.${body.action}` };
      }
    }
    if (event === 'issue_comment') {
      if (!body.issue?.pull_request) return { kind: 'ignored', reason: 'not a PR comment' };
      // A bot's comment (maybe ours) changed by someone other than that bot.
      if ((body.action === 'edited' || body.action === 'deleted') && body.comment?.user?.type === 'Bot') {
        if (body.sender?.login === body.comment.user.login) return { kind: 'ignored', reason: 'bot edited its own comment' };
        return {
          kind: 'bot_comment_changed', repo, prNumber: body.issue.number, commentId: String(body.comment.id),
          by: body.sender?.login ?? 'unknown', change: body.action, body: body.comment.body ?? '',
        };
      }
      if (body.action !== 'created') return { kind: 'ignored', reason: 'not a new PR comment' };
      if (body.comment.user?.type === 'Bot') return { kind: 'ignored', reason: 'bot comment' };
      return {
        kind: 'comment', repo, prNumber: body.issue.number, commentId: String(body.comment.id),
        author: body.comment.user.login, body: body.comment.body ?? '',
      };
    }
    if (event === 'check_run' && body.action === 'requested_action' && body.requested_action?.identifier === 'apply') {
      const prNumber = body.check_run.pull_requests?.[0]?.number;
      if (!prNumber) return { kind: 'ignored', reason: 'apply button without a PR' };
      return { kind: 'apply_button', repo, prNumber, project: body.check_run.external_id, user: body.sender.login };
    }
    return { kind: 'ignored', reason: `${event}${body.action ? `.${body.action}` : ''}` };
  }

  // ---- PR data ----

  async getPullRequest(repo: Repo, number: number): Promise<PullRequestState> {
    const { data } = await this.api(repo, 'GET', `/repos/${repo.fullName}/pulls/${number}`);
    return {
      ...this.prFrom(data),
      open: data.state === 'open',
      mergeable: data.mergeable ?? null,
      behindBase: data.mergeable_state === 'behind',
    };
  }

  async changedFiles(repo: Repo, number: number): Promise<string[]> {
    const files = await this.paginate<any>(repo, `/repos/${repo.fullName}/pulls/${number}/files`);
    // A rename touches both the old and the new location.
    return files.flatMap(f => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  }

  async cloneAuth(repo: Repo): Promise<CloneAuth> {
    const token = await this.installationToken(repo);
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    addSecret(basic);
    return { url: repo.cloneUrl, extraHeader: `Authorization: Basic ${basic}` };
  }

  // ---- writing to the PR ----

  async upsertComment(repo: Repo, number: number, marker: string, body: string, knownId?: string | null): Promise<{ id: string; url: string } | null> {
    // Fast path: edit the comment we made last time, without listing the PR's comments.
    if (knownId) {
      const { status, data } = await this.api(repo, 'PATCH', `/repos/${repo.fullName}/issues/comments/${encodeURIComponent(knownId)}`, { body }, [404]);
      if (status === 200) return { id: String(data.id), url: data.html_url };
    }
    const comments = await this.paginate<any>(repo, `/repos/${repo.fullName}/issues/${number}/comments`);
    const mine = comments.find(c => c.performed_via_github_app?.id === Number(this.cfg.appId) && c.body?.includes(marker))
      ?? comments.find(c => c.user?.type === 'Bot' && c.body?.includes(marker));
    const { data } = mine
      ? await this.api(repo, 'PATCH', `/repos/${repo.fullName}/issues/comments/${mine.id}`, { body })
      : await this.api(repo, 'POST', `/repos/${repo.fullName}/issues/${number}/comments`, { body });
    return data?.id != null ? { id: String(data.id), url: data.html_url } : null;
  }

  async comment(repo: Repo, number: number, body: string): Promise<string | null> {
    const { data } = await this.api(repo, 'POST', `/repos/${repo.fullName}/issues/${number}/comments`, { body });
    return data?.id != null ? String(data.id) : null;
  }

  async editComment(repo: Repo, commentId: string, body: string): Promise<void> {
    await this.api(repo, 'PATCH', `/repos/${repo.fullName}/issues/comments/${encodeURIComponent(commentId)}`, { body });
  }

  async react(repo: Repo, _number: number, commentId: string, reaction: Reaction): Promise<void> {
    try {
      await this.api(repo, 'POST', `/repos/${repo.fullName}/issues/comments/${commentId}/reactions`, { content: reaction });
    } catch (err) {
      log.warn('reaction failed', { err });
    }
  }

  async setCheck(repo: Repo, check: CheckRun): Promise<string | null> {
    const body: Record<string, unknown> = {
      name: check.name,
      head_sha: check.headSha,
      external_id: check.externalId,
      status: check.status,
      details_url: check.detailsUrl,
      output: { title: check.title.slice(0, 250), summary: check.summary, text: check.text },
      actions: check.actions,
    };
    if (check.status === 'completed') body.conclusion = check.conclusion;
    const { data } = await this.api(repo, 'GET',
      `/repos/${repo.fullName}/commits/${check.headSha}/check-runs?check_name=${encodeURIComponent(check.name)}&filter=latest`);
    const existing = data.check_runs?.find((c: any) => c.app?.id === Number(this.cfg.appId)) ?? data.check_runs?.[0];
    const { data: saved } = existing
      ? await this.api(repo, 'PATCH', `/repos/${repo.fullName}/check-runs/${existing.id}`, body)
      : await this.api(repo, 'POST', `/repos/${repo.fullName}/check-runs`, body);
    return saved?.html_url ?? null;
  }

  // ---- RBAC lookups ----

  userPermission(repo: Repo, user: string): Promise<Permission> {
    return this.permCache.get(`${repo.fullName}:${user}`, async () => {
      const { status, data } = await this.api(repo, 'GET', `/repos/${repo.fullName}/collaborators/${encodeURIComponent(user)}/permission`, undefined, [404]);
      if (status === 404) return 'none';
      // role_name is precise (maintain/triage); permission is the legacy field.
      const role = String(data.role_name ?? data.permission ?? 'none');
      return (['admin', 'maintain', 'write', 'triage', 'read'].includes(role) ? role : role === 'push' ? 'write' : role === 'pull' ? 'read' : 'none') as Permission;
    });
  }

  inTeam(repo: Repo, team: string, user: string): Promise<boolean> {
    const [org, slug] = team.includes('/') ? team.split('/', 2) : [repo.owner, team];
    return this.teamCache.get(`${org}/${slug}:${user}`, async () => {
      const { status, data } = await this.api(repo, 'GET',
        `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(user)}`, undefined, [404, 403]);
      return status === 200 && data?.state === 'active';
    });
  }

  async reviews(repo: Repo, number: number): Promise<Review[]> {
    const list = await this.paginate<any>(repo, `/repos/${repo.fullName}/pulls/${number}/reviews`);
    const states: Record<string, Review['state']> = {
      APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented', DISMISSED: 'dismissed',
    };
    return list.filter(r => states[r.state] && r.user).map(r => ({ user: r.user.login, state: states[r.state], commitSha: r.commit_id }));
  }

  async fileAt(repo: Repo, path: string, ref: string): Promise<string | null> {
    const { status, data } = await this.api(repo, 'GET',
      `/repos/${repo.fullName}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, undefined, [404]);
    return status === 200 && typeof data?.content === 'string' ? Buffer.from(data.content, 'base64').toString('utf-8') : null;
  }

  codeowners(repo: Repo, ref: string): Promise<string | null> {
    return this.ownersCache.get(`${repo.fullName}@${ref}`, async () => {
      for (const path of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
        const text = await this.fileAt(repo, path, ref);
        if (text !== null) return text;
      }
      return null;
    });
  }
}
