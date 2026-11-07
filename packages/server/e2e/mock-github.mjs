// Minimal GitHub API for end-to-end tests: just the endpoints tfv-server uses.
// State is kept in memory and exposed at GET /_state for assertions.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const REPO_DIR = process.env.REPO_DIR || '/tmp/git/infra.git';
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR, encoding: 'utf-8' }).trim();
const PERMS = { bob: 'write', alice: 'admin' };

const state = { head, comments: [], checks: [], reactions: 0, nextId: 1 };

const pr = {
  number: 1, title: 'Add dev app', html_url: 'http://mock/pr/1', state: 'open', draft: false,
  user: { login: 'bob' }, mergeable: true, mergeable_state: 'clean',
  head: { sha: head, ref: 'feat', repo: { full_name: 'acme/infra' } },
  base: { ref: 'main', repo: { full_name: 'acme/infra' } },
};

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : null;
  const url = new URL(req.url, 'http://mock');
  const p = url.pathname;
  const m = (re) => re.exec(p);

  if (p === '/_state') return json(res, 200, state);
  if (req.method === 'POST' && m(/^\/app\/installations\/\d+\/access_tokens$/)) {
    if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(req.headers.authorization ?? '')) return json(res, 401, { message: 'bad JWT' });
    return json(res, 201, { token: 'ghs_e2e_token', expires_at: new Date(Date.now() + 3600e3).toISOString() });
  }
  if (p === '/app/installations') return json(res, 200, []);
  if (req.headers.authorization !== 'Bearer ghs_e2e_token') return json(res, 401, { message: 'bad token' });

  if (p === '/repos/acme/infra/pulls/1') return json(res, 200, pr);
  if (p === '/repos/acme/infra/pulls/1/files') return json(res, 200, [{ filename: 'envs/dev/main.tf' }]);
  if (p === '/repos/acme/infra/pulls/1/reviews') return json(res, 200, []);
  if (p === '/repos/acme/infra/issues/1/comments') {
    if (req.method === 'GET') return json(res, 200, state.comments);
    const c = { id: state.nextId++, body: body.body, user: { type: 'Bot' }, performed_via_github_app: { id: 1 } };
    state.comments.push(c);
    return json(res, 201, c);
  }
  const edit = m(/^\/repos\/acme\/infra\/issues\/comments\/(\d+)$/);
  if (edit && req.method === 'PATCH') {
    const c = state.comments.find(x => x.id === Number(edit[1]));
    c.body = body.body;
    return json(res, 200, c);
  }
  if (m(/^\/repos\/acme\/infra\/issues\/comments\/\d+\/reactions$/)) { state.reactions++; return json(res, 201, {}); }
  if (m(/^\/repos\/acme\/infra\/commits\/\w+\/check-runs$/)) {
    const name = url.searchParams.get('check_name');
    return json(res, 200, { check_runs: state.checks.filter(c => c.name === name).map(c => ({ id: c.id, app: { id: 1 } })) });
  }
  if (p === '/repos/acme/infra/check-runs' && req.method === 'POST') {
    const c = { id: state.nextId++, ...body };
    state.checks.push(c);
    return json(res, 201, c);
  }
  const chk = m(/^\/repos\/acme\/infra\/check-runs\/(\d+)$/);
  if (chk && req.method === 'PATCH') {
    const c = state.checks.find(x => x.id === Number(chk[1]));
    Object.assign(c, body);
    return json(res, 200, c);
  }
  const perm = m(/^\/repos\/acme\/infra\/collaborators\/([\w-]+)\/permission$/);
  if (perm) return PERMS[perm[1]] ? json(res, 200, { role_name: PERMS[perm[1]] }) : json(res, 404, {});
  if (m(/^\/orgs\/.+\/memberships\/.+$/)) return json(res, 404, {});
  if (m(/^\/repos\/acme\/infra\/contents\//)) return json(res, 404, {});

  json(res, 404, { message: `mock has no ${req.method} ${p}` });
}).listen(3000, () => console.log('mock GitHub on :3000, head', head));
