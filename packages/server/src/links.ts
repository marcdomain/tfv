// Web links into the source-control tool for PRs, commits, files and people.
import type { Platform } from './vcs/types.ts';

export interface RepoLinks {
  platform: Platform;
  name: string;                                        // "GitHub", "GitLab", ...
  repo: string;
  pr(n: number): string;
  comment(n: number, id: string): string;              // jumps to one comment on the PR
  commit(sha: string): string;
  tree(sha: string, dir: string): string;
  file(sha: string, path: string, start?: number, end?: number): string;
  user(login: string): string | null;                  // null when the platform has no simple profile URL
}

// Guess the platform from the host when no adapter claims it.
export const platformForHost = (host: string, known: Record<string, Platform> = {}): Platform =>
  known[host] ?? (/gitlab/i.test(host) ? 'gitlab' : /bitbucket/i.test(host) ? 'bitbucket' : /dev\.azure\.com|visualstudio\.com/i.test(host) ? 'azure' : 'github');

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

// repoKey is "host/owner/name" (Azure DevOps: "dev.azure.com/org/project/repo").
export const repoLinks = (repoKey: string, platform: Platform): RepoLinks => {
  const [host, ...rest] = repoKey.split('/');
  const path = rest.join('/');
  const base = `https://${host}/${path}`;
  const dirOrRoot = (d: string) => (d === '.' ? '' : enc(d));
  switch (platform) {
    case 'gitlab':
      return {
        platform, name: 'GitLab', repo: base,
        pr: n => `${base}/-/merge_requests/${n}`,
        comment: (n, id) => `${base}/-/merge_requests/${n}#note_${id}`,
        commit: sha => `${base}/-/commit/${sha}`,
        tree: (sha, d) => `${base}/-/tree/${sha}/${dirOrRoot(d)}`,
        file: (sha, f, a, b) => `${base}/-/blob/${sha}/${enc(f)}${a ? `#L${a}${b && b !== a ? `-${b}` : ''}` : ''}`,
        user: login => `https://${host}/${encodeURIComponent(login)}`,
      };
    case 'bitbucket':
      return {
        platform, name: 'Bitbucket', repo: base,
        pr: n => `${base}/pull-requests/${n}`,
        comment: (n, id) => `${base}/pull-requests/${n}#comment-${id}`,
        commit: sha => `${base}/commits/${sha}`,
        tree: (sha, d) => `${base}/src/${sha}/${dirOrRoot(d)}`,
        file: (sha, f, a, b) => `${base}/src/${sha}/${enc(f)}${a ? `#lines-${a}${b && b !== a ? `:${b}` : ''}` : ''}`,
        user: () => null,
      };
    case 'azure': {
      const [org, project, repo] = rest;
      const r = `https://${host}/${org}/${project}/_git/${repo}`;
      return {
        platform, name: 'Azure DevOps', repo: r,
        pr: n => `${r}/pullrequest/${n}`,
        comment: (n, id) => `${r}/pullrequest/${n}?discussionId=${id}`,
        commit: sha => `${r}/commit/${sha}`,
        tree: (sha, d) => `${r}?path=/${d === '.' ? '' : encodeURIComponent(d)}&version=GC${sha}`,
        file: (sha, f, a, b) => `${r}?path=/${encodeURIComponent(f)}&version=GC${sha}${a ? `&line=${a}&lineEnd=${(b ?? a) + 1}&lineStartColumn=1&lineEndColumn=1` : ''}`,
        user: () => null,
      };
    }
    default:
      return {
        platform: 'github', name: 'GitHub', repo: base,
        pr: n => `${base}/pull/${n}`,
        comment: (n, id) => `${base}/pull/${n}#issuecomment-${id}`,
        commit: sha => `${base}/commit/${sha}`,
        tree: (sha, d) => `${base}/tree/${sha}/${dirOrRoot(d)}`,
        file: (sha, f, a, b) => `${base}/blob/${sha}/${enc(f)}${a ? `#L${a}${b && b !== a ? `-L${b}` : ''}` : ''}`,
        user: login => `https://${host}/${encodeURIComponent(login)}`,
      };
  }
};
