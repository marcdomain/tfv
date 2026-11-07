// Platform-neutral contract. GitHub, GitLab, Bitbucket and Azure DevOps each
// implement VcsAdapter; the rest of the server only sees these types.

export type Platform = 'github' | 'gitlab' | 'bitbucket' | 'azure';

export interface Repo {
  platform: Platform;
  host: string;             // "github.com", or a self-hosted host
  owner: string;            // org / group / workspace / project
  name: string;
  fullName: string;         // "owner/name"
  cloneUrl: string;         // https clone URL without credentials
  installationId?: number;  // GitHub App installation
  defaultBranch?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
  fromFork: boolean;
}

export interface PullRequestState extends PullRequest {
  open: boolean;
  mergeable: boolean | null;   // null: platform still computing
  behindBase: boolean;         // base has commits the head lacks
}

export type VcsEvent =
  | { kind: 'pr_opened' | 'pr_updated'; repo: Repo; pr: PullRequest }
  | { kind: 'pr_closed'; repo: Repo; pr: PullRequest; merged: boolean }
  | { kind: 'comment'; repo: Repo; prNumber: number; commentId: string; author: string; body: string }
  | { kind: 'apply_button'; repo: Repo; prNumber: number; project: string; user: string }
  | { kind: 'ignored'; reason: string };

// Repo permission levels, lowest to highest.
export const PERMISSION_LEVELS = ['none', 'read', 'triage', 'write', 'maintain', 'admin'] as const;
export type Permission = typeof PERMISSION_LEVELS[number];

export interface Review {
  user: string;
  state: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  commitSha: string;
}

export interface CheckRun {
  name: string;
  headSha: string;
  externalId?: string;      // project key, echoed back by the Apply button
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'action_required' | 'cancelled';
  title: string;
  summary: string;
  text?: string;
  detailsUrl?: string;
  actions?: { label: string; identifier: string; description: string }[];
}

export interface CloneAuth {
  url: string;
  // Sent as an HTTP header by git, so tokens never land in .git/config.
  extraHeader?: string;
}

export type Reaction = 'eyes' | '+1' | '-1' | 'rocket' | 'confused';

export interface VcsAdapter {
  readonly platform: Platform;
  // Max characters in one PR comment.
  readonly commentLimit: number;
  readonly supportsChecks: boolean;

  verify(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): boolean;
  parse(headers: Record<string, string | string[] | undefined>, body: unknown): VcsEvent;

  getPullRequest(repo: Repo, number: number): Promise<PullRequestState>;
  changedFiles(repo: Repo, number: number): Promise<string[]>;
  cloneAuth(repo: Repo): Promise<CloneAuth>;

  // Creates or edits the comment that contains `marker`.
  upsertComment(repo: Repo, number: number, marker: string, body: string): Promise<void>;
  comment(repo: Repo, number: number, body: string): Promise<void>;
  react(repo: Repo, number: number, commentId: string, reaction: Reaction): Promise<void>;
  setCheck(repo: Repo, check: CheckRun): Promise<void>;

  // RBAC lookups.
  userPermission(repo: Repo, user: string): Promise<Permission>;
  // `team` is "slug" (same org as the repo) or "org/slug".
  inTeam(repo: Repo, team: string, user: string): Promise<boolean>;
  reviews(repo: Repo, number: number): Promise<Review[]>;
  // A file's content at a ref, or null. Rules are read from the base branch
  // so a PR can't loosen its own rules or CODEOWNERS.
  fileAt(repo: Repo, path: string, ref: string): Promise<string | null>;
  codeowners(repo: Repo, ref: string): Promise<string | null>;
  // Every repo the integration can see (for scheduled drift checks).
  listRepos(): Promise<Repo[]>;
}
