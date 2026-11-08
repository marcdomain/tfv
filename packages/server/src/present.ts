// Shapes API responses for the dashboard: adds who is responsible and links
// into the source-control tool (PRs, commits, files, profiles).
import type { Platform } from './vcs/types.ts';
import type { Person } from './config.ts';
import type { Run, Lock, AuditEntry } from './store.ts';
import { repoLinks, platformForHost, type RepoLinks } from './links.ts';
import { findPerson, githubLoginFromEmail } from './notify.ts';
import { avatarPath } from './avatars.ts';

export interface Presenter {
  run(r: Run): Run & { links: Record<string, string | null> };
  lock(l: Lock): Lock & { links: Record<string, string | null> };
  audit(a: AuditEntry): AuditEntry & { links: Record<string, string | null> };
  drift(d: Record<string, any>): Record<string, any>;
  finding(f: Record<string, any>): Record<string, any>;
}

// Platform logins look like this; display names ("Ada Admin") don't.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const presenter = (known: Record<string, Platform>, people: Person[]): Presenter => {
  const cache = new Map<string, RepoLinks>();
  const L = (repoKey: string) => {
    let l = cache.get(repoKey);
    if (!l) {
      l = repoLinks(repoKey, platformForHost(repoKey.split('/')[0], known));
      cache.set(repoKey, l);
    }
    return l;
  };
  const profile = (l: RepoLinks, login: string | undefined | null) =>
    login && LOGIN.test(login) && login !== 'dashboard' ? l.user(login) : null;
  const face = (repoKey: string, login: string | undefined | null) =>
    login && LOGIN.test(login) ? avatarPath(L(repoKey).platform, repoKey.split('/')[0], login) : null;
  // A commit author's platform login: from a no-reply email or the people table.
  const loginOf = (name: string, email: string) =>
    githubLoginFromEmail(email) ?? findPerson(people, { name, email })?.github ?? null;

  return {
    run(r) {
      const l = L(r.repo);
      return {
        ...r,
        links: {
          platform: l.name, repo: l.repo, pr: l.pr(r.pr), commit: l.commit(r.headSha),
          tree: l.tree(r.headSha, r.dir || r.project), user: profile(l, r.user), prAuthor: profile(l, r.prAuthor),
          userAvatar: face(r.repo, r.user), prAuthorAvatar: face(r.repo, r.prAuthor),
        },
      };
    },
    lock(lk) {
      const l = L(lk.repo);
      return { ...lk, links: { platform: l.name, pr: l.pr(lk.pr), user: profile(l, lk.user), userAvatar: face(lk.repo, lk.user) } };
    },
    audit(a) {
      const l = L(a.repo);
      return { ...a, links: { platform: l.name, pr: a.pr ? l.pr(a.pr) : null, user: profile(l, a.user), userAvatar: profile(l, a.user) ? face(a.repo, a.user) : null } };
    },
    finding(f) {
      const l = L(String(f.repo));
      return { ...f, links: { platform: l.name, pr: l.pr(Number(f.pr)), user: profile(l, String(f.user)), userAvatar: face(String(f.repo), String(f.user)) } };
    },
    drift(d) {
      const l = L(d.repo);
      const f = d.finding ?? {};
      return {
        ...d,
        links: { platform: l.name, commit: l.commit(d.sha), tree: l.tree(d.sha, d.project) },
        finding: {
          ...f,
          drift: (f.drift ?? []).map((x: any) => {
            const a = x.author;
            const login = a ? loginOf(a.name, a.email) : null;
            return {
              ...x,
              links: {
                file: a?.file ? l.file(d.sha, a.file, a.start, a.end) : l.tree(d.sha, d.project),
                commit: a ? l.commit(a.sha) : null,
                author: profile(l, login),
                authorLogin: login,
                authorAvatar: face(d.repo, login),
              },
            };
          }),
          lastApply: f.lastApply ? { ...f.lastApply, links: { pr: l.pr(f.lastApply.pr), user: profile(l, f.lastApply.user), userAvatar: face(d.repo, f.lastApply.user) } } : null,
        },
      };
    },
  };
};
