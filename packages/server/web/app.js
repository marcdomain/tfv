// tfv server dashboard: a small single-page app over the /api endpoints.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const view = $('#view');
  // An API token (kept for this tab only) or, normally, the session cookie.
  let token = null;
  try { token = sessionStorage.getItem('tfv-token'); } catch { /* storage blocked */ }
  let me = null;

  // ---- API ----------------------------------------------------------------
  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      ...opts,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'tfv',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (res.status === 401) { signOut('Your session ended. Sign in again.'); throw new Error('unauthorized'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  };
  const isAdmin = () => me?.role === 'admin';
  const adminButton = (label, attrs) => isAdmin()
    ? `<button class="ghost small" type="button" ${attrs}>${label}</button>`
    : `<button class="ghost small" type="button" disabled title="Admins only">${label}</button>`;

  // ---- formatting ---------------------------------------------------------
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const duration = (a, b) => {
    if (!a || !b) return '';
    const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  const prUrl = (repo, pr) => {
    const [host, ...rest] = repo.split('/');
    return host === 'github.com' ? `https://github.com/${rest.join('/')}/pull/${pr}` : null;
  };
  const repoName = (repo) => repo.split('/').slice(1).join('/');
  const statusPill = (r) => {
    if (r.status === 'running' || r.status === 'queued') return '<span class="pill run">running</span>';
    if (r.status === 'failed') return `<span class="pill bad">${r.kind} failed</span>`;
    if (r.kind === 'apply') return '<span class="pill ok">applied</span>';
    if (!r.hasChanges) return '<span class="pill ok">no changes</span>';
    return r.destroys ? '<span class="pill warn">destroys</span>' : '<span class="pill">changes</span>';
  };
  const summaryOf = (r) => { try { return r.summary ? JSON.parse(r.summary) : null; } catch { return null; } };
  const counts = (s) => {
    if (!s) return '<span class="muted">—</span>';
    if (s.noChanges) return '<span class="muted">no changes</span>';
    const parts = [];
    if (s.add) parts.push(`<span class="a">+${s.add}</span>`);
    if (s.change) parts.push(`<span class="c">~${s.change}</span>`);
    if (s.replace) parts.push(`<span class="d">±${s.replace}</span>`);
    if (s.destroy) parts.push(`<span class="d">−${s.destroy}</span>`);
    return `<span class="counts">${parts.join(' ') || 'outputs'}</span>`;
  };
  const PAST = { create: 'created', update: 'changed', delete: 'deleted', replace: 'replaced' };
  const SYMBOL = { create: '+', update: '~', delete: '-', replace: '-/+', import: '←', forget: '⊘', move: '→' };
  const LINE = { create: 'l-add', update: 'l-chg', delete: 'l-del', replace: 'l-del' };
  const changeLines = (list) => list.map(c =>
    `<span class="${LINE[c.action] || ''}">${esc((SYMBOL[c.action] || '?').padEnd(3))} ${esc(c.address)}${c.reason ? `   # ${esc(c.reason)}` : ''}</span>`).join('\n');

  const table = (head, rows, empty) => rows.length
    ? `<div class="scroll"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<div class="empty">${empty}</div>`;

  // ---- views --------------------------------------------------------------
  const runRow = (r) => {
    const s = summaryOf(r);
    return `<tr class="click" data-run="${r.id}">
      <td>${statusPill(r)}</td>
      <td class="mono">${esc(r.project)}${r.workspace !== 'default' ? ` <span class="muted">@${esc(r.workspace)}</span>` : ''}${r.targets?.length ? ' <span class="pill run">targeted</span>' : ''}</td>
      <td>${r.kind === 'plan' ? counts(s) : '<span class="muted">apply</span>'}</td>
      <td>${esc(repoName(r.repo))} <span class="muted">#${r.pr}</span></td>
      <td>${esc(r.user)}</td>
      <td class="muted">${esc(r.engine || '')}</td>
      <td class="muted" title="${esc(when(r.startedAt))}">${ago(r.startedAt)}</td>
    </tr>`;
  };

  const views = {
    async overview() {
      const [runs, locks, drift, schedules] = await Promise.all([
        api('/api/runs?limit=100'), api('/api/locks'), api('/api/drift'), api('/api/drift/schedules'),
      ]);
      const day = Date.now() - 86400e3;
      const today = runs.filter(r => Date.parse(r.startedAt) > day);
      const latestDrift = new Map();
      for (const d of drift) {
        const k = `${d.schedule_key}|${d.project}`;
        if (!latestDrift.has(k)) latestDrift.set(k, d);
      }
      const drifted = [...latestDrift.values()].filter(d => d.status === 'drift');
      const failed = today.filter(r => r.status === 'failed');
      const nextRun = schedules.map(s => s.next).filter(Boolean).sort()[0];
      return `
        <div class="page-head"><h1>Overview</h1><span class="muted">Everything tfv did across your repos</span></div>
        <div class="tiles">
          <div class="tile"><span class="n">${today.length}</span><span class="k">runs in the last 24 hours</span></div>
          <div class="tile ${failed.length ? 'bad' : ''}"><span class="n">${failed.length}</span><span class="k">failed runs</span></div>
          <div class="tile ${locks.length ? 'warn' : ''}"><span class="n">${locks.length}</span><span class="k">projects locked by a PR</span></div>
          <div class="tile ${drifted.length ? 'warn' : ''}"><span class="n">${drifted.length}</span><span class="k">projects with drift</span></div>
          <div class="tile"><span class="n">${schedules.length}</span><span class="k">drift schedules${nextRun ? `, next ${new Date(nextRun).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Recent runs</h2><a href="#runs">All runs</a></div>
          ${table(['Result', 'Project', 'Changes', 'Pull request', 'By', 'Engine', 'When'], runs.slice(0, 8).map(runRow), 'No runs yet. Open a pull request that changes Terraform code.')}
        </div>
        <div class="grid2">
          <div class="card">
            <div class="card-head"><h2>Locks</h2><a href="#locks">Manage</a></div>
            ${table(['Project', 'Held by', 'Since'], locks.slice(0, 6).map(l => `<tr><td class="mono">${esc(l.project)}</td><td>${esc(repoName(l.repo))} #${l.pr} · ${esc(l.user)}</td><td class="muted">${ago(l.createdAt)}</td></tr>`), 'No projects are locked.')}
          </div>
          <div class="card">
            <div class="card-head"><h2>Drift</h2><a href="#drift">Details</a></div>
            ${table(['Project', 'Status', 'Checked'], [...latestDrift.values()].slice(0, 6).map(d => `<tr><td class="mono">${esc(d.project)}</td><td>${driftPill(d)}</td><td class="muted">${ago(d.at)}</td></tr>`), 'No drift checks have run yet.')}
          </div>
        </div>`;
    },

    async runs() {
      const runs = await api('/api/runs?limit=200');
      return `
        <div class="page-head"><h1>Runs</h1><span class="muted">${runs.length} most recent plans and applies</span></div>
        <div class="card">${table(['Result', 'Project', 'Changes', 'Pull request', 'By', 'Engine', 'When'], runs.map(runRow), 'No runs yet.')}</div>`;
    },

    async run(id) {
      const r = await api(`/api/runs/${encodeURIComponent(id)}`);
      const s = summaryOf(r);
      const link = prUrl(r.repo, r.pr);
      const dangerous = s ? s.changes.filter(c => c.action === 'delete' || c.action === 'replace') : [];
      return `
        <div class="detail-head">
          <a href="#runs" class="small">← All runs</a>
          <div class="page-head"><h1 class="mono">${esc(r.project)}</h1>${statusPill(r)}</div>
          <div class="meta">
            <span><b>${esc(r.kind)}</b> by ${esc(r.user)}</span>
            <span>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(repoName(r.repo))} #${r.pr}</a>` : `${esc(repoName(r.repo))} #${r.pr}`}</span>
            <span class="mono">${esc(r.headSha.slice(0, 7))}</span>
            <span>${esc(r.engine)}</span>
            <span title="${esc(when(r.startedAt))}">${ago(r.startedAt)}${r.finishedAt ? ` · took ${duration(r.startedAt, r.finishedAt)}` : ''}</span>
          </div>
        </div>
        ${r.targets?.length ? `<div class="banner note">Targeted plan: only ${r.targets.map(t => `<code>${esc(t)}</code>`).join(', ')}.</div>` : ''}
        ${dangerous.length ? `<div class="banner"><b>${dangerous.length} resource${dangerous.length === 1 ? '' : 's'} will be destroyed or replaced.</b></div>` : ''}
        ${s && s.changes.length ? `<div class="card"><div class="card-head"><h2>Changes</h2>${counts(s)}</div><pre class="changes">${changeLines(s.changes)}</pre></div>` : ''}
        ${s && (s.drift.length || s.outputs.length) ? `<div class="grid2">
          <div class="card"><div class="card-head"><h2>Changed outside Terraform</h2></div>${s.drift.length ? `<pre class="changes">${changeLines(s.drift)}</pre>` : '<div class="empty">None</div>'}</div>
          <div class="card"><div class="card-head"><h2>Outputs</h2></div>${s.outputs.length ? `<pre class="changes">${s.outputs.map(o => `${esc(SYMBOL[o.action] || '~')}   ${esc(o.name)}`).join('\n')}</pre>` : '<div class="empty">None</div>'}</div>
        </div>` : ''}
        <div class="card"><div class="card-head"><h2>Output</h2><span class="muted small">secrets redacted</span></div><pre class="log">${esc(r.output || '')}</pre></div>`;
    },

    async locks() {
      const locks = await api('/api/locks');
      return `
        <div class="page-head"><h1>Locks</h1><span class="muted">A PR holds a project from its first plan until it merges, closes or unlocks</span></div>
        <div class="card">${table(['Project', 'Workspace', 'Repository', 'Pull request', 'Locked by', 'Since', ''], locks.map(l => {
          const link = prUrl(l.repo, l.pr);
          return `<tr>
            <td class="mono">${esc(l.project)}</td><td class="mono muted">${esc(l.workspace)}</td><td>${esc(repoName(l.repo))}</td>
            <td>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">#${l.pr}</a>` : `#${l.pr}`}</td>
            <td>${esc(l.user)}</td><td class="muted" title="${esc(when(l.createdAt))}">${ago(l.createdAt)}</td>
            <td>${adminButton('Unlock', `data-unlock='${esc(JSON.stringify({ repo: l.repo, project: l.project, workspace: l.workspace }))}'`)}</td>
          </tr>`;
        }), 'No projects are locked.')}</div>`;
    },

    async drift() {
      const [schedules, drift] = await Promise.all([api('/api/drift/schedules'), api('/api/drift')]);
      const latest = new Map();
      for (const d of drift) {
        const k = `${d.schedule_key}|${d.project}`;
        if (!latest.has(k)) latest.set(k, d);
      }
      const findings = [...latest.values()];
      return `
        <div class="page-head"><h1>Drift</h1><span class="muted">Scheduled read-only checks for changes made outside Terraform</span></div>
        <div class="card"><div class="card-head"><h2>Schedules</h2></div>
          ${table(['Name', 'Repository', 'Branch', 'Projects', 'Schedule', 'Next run', 'Notifies', ''], schedules.map(s => `<tr>
            <td><b>${esc(s.name || '—')}</b> <span class="muted small">${esc(s.source)}</span></td>
            <td>${esc(s.repo)}</td><td class="mono">${esc(s.branch)}</td><td class="mono wrap">${s.projects.map(esc).join(', ')}</td>
            <td class="mono">${esc(s.schedule)} <span class="muted">${esc(s.timezone)}</span></td>
            <td>${s.next ? esc(new Date(s.next).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : '—'}</td>
            <td>${s.notify.map(n => `<span class="pill">${esc(n)}</span>`).join(' ')}</td>
            <td>${adminButton('Run now', `data-drift="${esc(s.key)}"`)}</td>
          </tr>`), 'No drift schedules. Add one under <code>drift:</code> in repos.yaml or a repo\'s tfv.yaml.')}
        </div>
        ${findings.map(d => {
          const f = d.finding;
          return `<div class="card">
            <div class="card-head"><h2><span class="mono">${esc(d.project)}</span> <span class="muted">· ${esc(repoName(d.repo))} @ ${esc(d.branch)} · ${esc(d.sha.slice(0, 7))}</span></h2>${driftPill(d)}</div>
            ${f.error ? `<pre class="log">${esc(f.error)}</pre>` : table(['Resource', 'What happened', 'Last changed by', 'Commit'], f.drift.map(x => `<tr>
              <td class="mono">${esc(x.address)}</td><td>${esc(PAST[x.action] || x.action)} outside Terraform</td>
              <td>${x.author ? `<b>${esc(x.author.name)}</b> <span class="muted small">${esc(x.author.email)}</span>` : '<span class="muted">unknown</span>'}</td>
              <td class="wrap">${x.author ? `<span class="mono">${esc(x.author.sha.slice(0, 7))}</span> <span class="muted">${esc(x.author.subject)}</span>` : ''}</td>
            </tr>`), 'Nothing changed outside Terraform.')}
            <div class="card-foot">
              <span class="muted small">${f.lastApply ? `Last applied by <b>${esc(f.lastApply.user)}</b> via PR #${f.lastApply.pr}` : 'Never applied through tfv'}${f.pending && Object.values(f.pending).some(Boolean) ? ` · merged but not applied: ${counts(f.pending)}` : ''}</span>
              <span class="muted small">checked ${ago(d.at)}${d.notified ? ` · notified ${d.notified.map(n => esc(n.channel)).join(', ')}` : ''}</span>
            </div>
          </div>`;
        }).join('')}`;
    },

    async audit() {
      const entries = await api('/api/audit');
      return `
        <div class="page-head"><h1>Audit log</h1><span class="muted">Every permission decision, allowed or denied</span></div>
        <div class="card">${table(['When', 'User', 'Action', 'Project', 'Pull request', 'Result'], entries.map(a => `<tr>
          <td class="muted" title="${esc(when(a.at))}">${ago(a.at)}</td><td><b>${esc(a.user)}</b></td><td class="mono">${esc(a.action)}</td>
          <td class="mono">${esc(a.project)}</td><td>${esc(repoName(a.repo))} #${a.pr}</td>
          <td class="wrap">${a.allowed ? '<span class="pill ok">allowed</span>' : `<span class="pill bad">denied</span> <span class="muted">${esc(a.reason.replace(/`/g, ''))}</span>`}</td>
        </tr>`), 'No decisions recorded yet.')}</div>`;
    },
  };

  function driftPill(d) {
    if (d.status === 'error') return '<span class="pill bad">check failed</span>';
    if (d.status === 'drift') return `<span class="pill warn">${d.finding?.drift?.length || 0} drifted</span>`;
    return '<span class="pill ok">clean</span>';
  }

  // ---- routing ------------------------------------------------------------
  let timer = null;
  const route = async () => {
    if (!me) return;
    const [name, arg] = (location.hash.slice(1) || 'overview').split('/');
    const viewName = views[name] ? name : 'overview';
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === (viewName === 'run' ? 'runs' : viewName)));
    try {
      view.innerHTML = await (viewName === 'runs' && arg ? views.run(arg) : views[viewName]());
      $('#refreshed').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } catch (err) {
      if (err.message !== 'unauthorized') view.innerHTML = `<div class="card"><div class="empty error">Could not load this page: ${esc(err.message)}</div></div>`;
    }
    clearTimeout(timer);
    // Keep lists fresh; run detail pages stay still so logs can be read.
    if (!(viewName === 'runs' && arg)) timer = setTimeout(route, 15000);
  };

  view.addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-run]');
    if (row && !e.target.closest('a,button')) { location.hash = `runs/${row.dataset.run}`; return; }
    const unlock = e.target.closest('button[data-unlock]');
    if (unlock) {
      if (unlock.dataset.confirm !== 'yes') { unlock.dataset.confirm = 'yes'; unlock.textContent = 'Click again to unlock'; return; }
      unlock.disabled = true;
      await api('/api/locks/unlock', { method: 'POST', body: unlock.dataset.unlock }).catch(err => alertRow(unlock, err));
      return route();
    }
    const run = e.target.closest('button[data-drift]');
    if (run) {
      run.disabled = true;
      await api(`/api/drift/run?key=${encodeURIComponent(run.dataset.drift)}`, { method: 'POST' })
        .then(() => { run.textContent = 'Started'; })
        .catch(err => alertRow(run, err));
    }
  });
  const alertRow = (btn, err) => { btn.textContent = err.message; btn.disabled = false; };

  // ---- theme ------------------------------------------------------------------
  const THEMES = ['system', 'light', 'dark'];
  const ICON = { system: '◐', light: '☀', dark: '☾' };
  let theme = 'system';
  try { theme = localStorage.getItem('tfv-theme') || 'system'; } catch { /* ignore */ }
  const applyTheme = () => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    const b = $('#theme');
    b.textContent = ICON[theme];
    b.title = `Theme: ${theme} (click to change)`;
    b.setAttribute('aria-label', b.title);
  };
  $('#theme').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem('tfv-theme', theme); } catch { /* ignore */ }
    applyTheme();
  });
  applyTheme();

  // ---- sign-in ------------------------------------------------------------
  const signedIn = (who) => {
    me = who;
    $('#signin').hidden = true;
    $('#signout').hidden = false;
    const el = $('#me');
    el.hidden = false;
    el.innerHTML = `<b>${esc(who.name)}</b> <span class="pill ${who.role === 'admin' ? 'run' : ''}">${esc(who.role)}</span>`;
    if (location.hash.startsWith('#signin-error')) history.replaceState(null, '', '#overview');
    route();
  };

  async function showSignIn(message) {
    me = null;
    clearTimeout(timer);
    view.innerHTML = '';
    $('#signin').hidden = false;
    $('#signout').hidden = true;
    $('#me').hidden = true;
    const errEl = $('#signin-error');
    errEl.hidden = !message;
    errEl.textContent = message || '';
    const cfg = await fetch('/auth/config').then(r => r.json()).catch(() => ({}));
    const sso = $('#sso');
    sso.hidden = !cfg.oidc;
    if (cfg.oidc) sso.textContent = `Sign in with ${cfg.oidc.name}`;
    $('#password-form').hidden = !cfg.password;
    $('#or').hidden = !(cfg.oidc && cfg.password);
    $('#token-box').hidden = !cfg.token;
    $('#token-box').open = cfg.token && !cfg.oidc && !cfg.password;
    $('#no-auth').hidden = !!(cfg.oidc || cfg.password || cfg.token);
    (cfg.password ? $('#username') : null)?.focus();
  }

  function signOut(message) {
    token = null;
    try { sessionStorage.removeItem('tfv-token'); } catch { /* ignore */ }
    fetch('/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'tfv' } }).catch(() => {});
    showSignIn(message);
  }

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'tfv' },
      body: JSON.stringify({ username: $('#username').value.trim(), password: $('#password').value }),
    }).catch(() => null);
    $('#password').value = '';
    if (!res) return showSignIn('Could not reach the server.');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return showSignIn(body.error || 'Sign-in failed.');
    signedIn(await api('/api/me'));
  });

  $('#token-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    token = $('#token').value.trim();
    $('#token').value = '';
    const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (!res || !res.ok) { token = null; return showSignIn('That token was not accepted.'); }
    try { sessionStorage.setItem('tfv-token', token); } catch { /* ignore */ }
    signedIn(await res.json());
  });

  $('#signout').addEventListener('click', () => signOut());
  window.addEventListener('hashchange', () => { if (me) route(); });

  // Start: an existing session or token signs in straight away.
  (async () => {
    const failure = /^#signin-error=(.*)$/.exec(location.hash);
    if (failure) return showSignIn(decodeURIComponent(failure[1]));
    const res = await fetch('/api/me', { credentials: 'same-origin', headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => null);
    if (res && res.ok) signedIn(await res.json()); else showSignIn();
  })();
})();
