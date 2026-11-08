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

  // ---- people and links ---------------------------------------------------
  const initials = (name) => String(name || '?').replace(/[^A-Za-z0-9 ._-]/g, '').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  const hue = (name) => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 8; };
  const ext = (url, text, cls = 'ext') => url ? `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
  // Avatar: the platform picture (served by tfv), or initials if there is none.
  const avatar = (name, src, size = '') => src
    ? `<img class="av ${size}" src="${esc(src)}" alt="" data-initials="${esc(initials(name))}" data-hue="${hue(name)}" loading="lazy">`
    : `<span class="av ${size} av${hue(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
  // A person: avatar, name (linked to their profile where the platform has one), optional role.
  const who = (name, url, role, src, size) => !name ? '<span class="muted">—</span>'
    : `<span class="who">${avatar(name, src, size)}${url ? `<a class="plain" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>` : esc(name)}${role ? ` <span class="role">${esc(role)}</span>` : ''}</span>`;
  // Pictures that fail to load (offline, no avatar) turn into initials.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('av')) return;
    const span = document.createElement('span');
    span.className = `${img.className} av${img.dataset.hue}`;
    span.textContent = img.dataset.initials;
    span.setAttribute('aria-hidden', 'true');
    img.replaceWith(span);
  }, true);
  const prLink = (r) => `<span class="inline">${platformIcon(r.links?.platform)}${ext(r.links?.pr, `${esc(repoName(r.repo))} <span class="muted">#${r.pr}</span>`, 'plain')}</span>`;
  const runPeople = (r, size) => {
    const L = r.links || {};
    const did = r.kind === 'apply' ? 'applied' : 'planned';
    if (!r.prAuthor || r.prAuthor === r.user) return who(r.user, L.user, r.prAuthor ? `author, ${did}` : did, L.userAvatar, size);
    return `${who(r.prAuthor, L.prAuthor, 'author', L.prAuthorAvatar, size)}${who(r.user, L.user, did, L.userAvatar, size)}`;
  };

  // Source-control marks (inline SVG: nothing loaded from outside).
  // GitHub's is the Octicons "mark-github" (MIT); the others are simplified marks.
  const PLATFORM_ICONS = {
    GitHub: ['gh', 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z'],
    GitLab: ['gl', 'M8 15 1 9.9l1.2-3.7L3.6 1.9c.1-.3.5-.3.6 0L5.6 6.2h4.8l1.4-4.3c.1-.3.5-.3.6 0l1.4 4.3L15 9.9Z'],
    Bitbucket: ['bb', 'M1.2 1.5a.5.5 0 0 0-.5.6l2 12.2c.1.4.4.7.8.7h9c.3 0 .6-.2.6-.5l2.1-12.4a.5.5 0 0 0-.5-.6Zm8.6 8.9H6.3L5.4 5.6h5.3Z'],
    'Azure DevOps': ['az', 'M15 3.6v8.6l-3.5 2.9-5.5-1.9v1.9L2.9 10.9l8.9.7V4.1ZM12 4l-5-3v2L2.4 4.4 1 6.2v4l1.9.7V5.8Z'],
  };
  const platformIcon = (name, size = 14) => {
    const [cls, d] = PLATFORM_ICONS[name] || [];
    return d ? `<svg class="pf pf-${cls}" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>` : '';
  };

  // In-dashboard links to filtered lists.
  const listLink = (view, params) => `#${view}?${new URLSearchParams(params)}`;
  const projLink = (project) => `<a class="plain" href="${esc(listLink('runs', { project }))}" title="Runs of ${esc(project)}">${esc(project)}</a>`;

  // ---- filters --------------------------------------------------------------
  const RANGES = [['24h', '24 h'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time'], ['custom', 'Custom']];
  const RANGE_MS = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 };
  // Turns the page's filters into API query parameters.
  const apiParams = (params, keys) => {
    const out = new URLSearchParams();
    for (const k of keys) if (params.get(k)) out.set(k, params.get(k));
    const range = params.get('range') || 'all';
    if (RANGE_MS[range]) out.set('from', new Date(Date.now() - RANGE_MS[range]).toISOString());
    if (range === 'custom') {
      if (params.get('from')) out.set('from', new Date(`${params.get('from')}T00:00`).toISOString());
      if (params.get('to')) out.set('to', new Date(new Date(`${params.get('to')}T00:00`).getTime() + 864e5).toISOString());
    }
    return out;
  };
  const opt = (value, label, current) => `<option value="${esc(value)}"${value === (current || '') ? ' selected' : ''}>${esc(label)}</option>`;
  const select = (name, label, options, params) =>
    `<label class="f"><span>${esc(label)}</span><select name="${name}">${options.map(([v, l]) => opt(v, l, params.get(name))).join('')}</select></label>`;
  const rangeControl = (params) => {
    const range = params.get('range') || 'all';
    return `<div class="f"><span>When</span><div class="seg" role="group" aria-label="Time range">${RANGES.map(([v, l]) =>
      `<button type="button" data-range="${v}" aria-pressed="${v === range}">${l}</button>`).join('')}</div></div>
      <div class="f custom"${range === 'custom' ? '' : ' hidden'}><span>From – to</span><span class="dates">
        <input type="date" name="from" value="${esc(params.get('from') || '')}" aria-label="From"> – <input type="date" name="to" value="${esc(params.get('to') || '')}" aria-label="To"></span></div>`;
  };
  const LABELS = {
    q: 'Search', user: 'Person', project: 'Project', status: 'Result', kind: 'Type', action: 'Action', result: 'Decision', range: 'When', sort: 'Sort',
  };
  const STATUS = [['', 'Any result'], ['changes', 'Has changes'], ['destroys', 'Destroys or replaces'], ['nochanges', 'No changes'], ['applied', 'Applied'], ['failed', 'Failed'], ['running', 'Running']];
  const chips = (params) => {
    const shown = [...params.entries()].filter(([k, v]) => v && LABELS[k] && k !== 'sort' && !(k === 'range' && v === 'all'));
    if (!shown.length) return '';
    const text = (k, v) => k === 'status' ? (STATUS.find(s => s[0] === v)?.[1] ?? v)
      : k === 'range' ? (v === 'custom' ? `${params.get('from') || '…'} – ${params.get('to') || '…'}` : RANGES.find(r => r[0] === v)?.[1] ?? v) : v;
    return `<div class="chips">${shown.map(([k, v]) =>
      `<button type="button" class="chip" data-clear="${k}" title="Remove this filter"><span>${esc(LABELS[k])}:</span> ${esc(text(k, v))} <b aria-hidden="true">×</b></button>`).join('')}
      <button type="button" class="chip clear" data-clear="*">Clear all</button></div>`;
  };

  // ---- views --------------------------------------------------------------
  const runRow = (r) => {
    const s = summaryOf(r);
    return `<tr class="click" data-run="${r.id}">
      <td>${statusPill(r)}</td>
      <td class="mono">${projLink(r.project)}${r.workspace !== 'default' ? ` <span class="muted">@${esc(r.workspace)}</span>` : ''}${r.targets?.length ? ' <span class="pill run">targeted</span>' : ''}</td>
      <td>${r.kind === 'plan' ? counts(s) : '<span class="muted">apply</span>'}</td>
      <td>${prLink(r)}</td>
      <td>${runPeople(r)}</td>
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
          <a class="tile" href="${listLink('runs', { range: '24h' })}"><span class="n">${today.length}</span><span class="k">runs in the last 24 hours</span></a>
          <a class="tile ${failed.length ? 'bad' : ''}" href="${listLink('runs', { status: 'failed', range: '24h' })}"><span class="n">${failed.length}</span><span class="k">failed runs in 24 hours</span></a>
          <a class="tile ${locks.length ? 'warn' : ''}" href="#locks"><span class="n">${locks.length}</span><span class="k">projects locked by a PR</span></a>
          <a class="tile ${drifted.length ? 'warn' : ''}" href="#drift"><span class="n">${drifted.length}</span><span class="k">projects with drift</span></a>
          <a class="tile" href="#drift"><span class="n">${schedules.length}</span><span class="k">drift schedules${nextRun ? `, next ${new Date(nextRun).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</span></a>
        </div>
        <div class="card">
          <div class="card-head"><h2>Recent runs</h2><a href="#runs">All runs</a></div>
          ${table(['Result', 'Project', 'Changes', 'Pull request', 'People', 'Engine', 'When'], runs.slice(0, 8).map(runRow), 'No runs yet. Open a pull request that changes Terraform code.')}
        </div>
        <div class="card">
          <div class="card-head"><h2>People</h2><span class="muted small">last 7 days · click a person for their runs</span></div>
          ${peopleTable(runs)}
        </div>
        <div class="grid2">
          <div class="card">
            <div class="card-head"><h2>Locks</h2><a href="#locks">Manage</a></div>
            ${table(['Project', 'Pull request', 'Held by', 'Since'], locks.slice(0, 6).map(l => `<tr><td class="mono">${projLink(l.project)}</td><td>${prLink(l)}</td><td>${who(l.user, l.links?.user, null, l.links?.userAvatar)}</td><td class="muted">${ago(l.createdAt)}</td></tr>`), 'No projects are locked.')}
          </div>
          <div class="card">
            <div class="card-head"><h2>Drift</h2><a href="#drift">Details</a></div>
            ${table(['Project', 'Status', 'Checked'], [...latestDrift.values()].slice(0, 6).map(d => `<tr><td class="mono">${projLink(d.project)}</td><td>${driftPill(d)}</td><td class="muted">${ago(d.at)}</td></tr>`), 'No drift checks have run yet.')}
          </div>
        </div>`;
    },

    async runs(_arg, params) {
      const f = await api('/api/facets');
      return `
        <div class="page-head"><h1>Runs</h1><span class="muted">Every plan and apply. Filter, search and sort.</span></div>
        <form class="filters" data-list="runs" autocomplete="off">
          <label class="f grow"><span>Search</span><input type="search" name="q" value="${esc(params.get('q') || '')}" placeholder="Person, project, repo or #PR"></label>
          ${select('user', 'Person', [['', 'Anyone'], ...f.users.map(u => [u, u])], params)}
          ${select('project', 'Project', [['', 'All projects'], ...f.projects.map(x => [x, x])], params)}
          ${select('status', 'Result', STATUS, params)}
          ${select('kind', 'Type', [['', 'Plans and applies'], ['plan', 'Plans'], ['apply', 'Applies']], params)}
          ${rangeControl(params)}
          ${select('sort', 'Sort', [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['changes', 'Biggest changes'], ['project', 'Project A–Z'], ['user', 'Person A–Z']], params)}
        </form>
        <div id="chips">${chips(params)}</div>
        <div class="card" id="results"><div class="empty">Loading…</div></div>`;
    },

    async projects(_arg, params) {
      const rows = await api('/api/projects');
      const q = (params.get('q') || '').toLowerCase();
      const sort = params.get('sort') || 'recent';
      const list = rows.filter(p => !q || `${p.project} ${p.repo} ${p.lastRun.user} ${p.lastApply?.user ?? ''}`.toLowerCase().includes(q))
        .sort((a, b) => sort === 'name' ? a.project.localeCompare(b.project) : sort === 'runs' ? b.runs - a.runs : b.lastRun.id - a.lastRun.id);
      return `
        <div class="page-head"><h1>Projects</h1><span class="muted">Every project tfv has planned, with who touched it last</span></div>
        <form class="filters" data-list="projects" autocomplete="off">
          <label class="f grow"><span>Search</span><input type="search" name="q" value="${esc(params.get('q') || '')}" placeholder="Project, repo or person"></label>
          ${select('sort', 'Sort', [['recent', 'Recently active'], ['name', 'Name A–Z'], ['runs', 'Most runs']], params)}
        </form>
        <div class="card">${table(['Project', 'Repository', 'Last run', 'By', 'Last applied', 'Lock', 'Runs'], list.map(p => {
          const r = p.lastRun;
          const a = p.lastApply;
          return `<tr class="click" data-href="${esc(listLink('runs', { project: p.project }))}">
            <td class="mono"><b>${esc(p.project)}</b>${p.workspace !== 'default' ? ` <span class="muted">@${esc(p.workspace)}</span>` : ''}</td>
            <td><span class="inline">${platformIcon(r.links?.platform)}${ext(r.links?.repo, esc(repoName(p.repo)), 'plain')}</span></td>
            <td>${statusPill(r)} ${r.kind === 'plan' ? counts(summaryOf(r)) : ''} <span class="muted small">${ago(r.startedAt)}</span></td>
            <td>${who(r.user, r.links?.user, null, r.links?.userAvatar)}</td>
            <td>${a ? `<span class="inline">${who(a.user, a.links?.user, null, a.links?.userAvatar)} <span class="muted small">${ago(a.finishedAt || a.startedAt)} · ${ext(a.links?.pr, `#${a.pr}`, 'plain')}</span></span>` : '<span class="muted">never</span>'}</td>
            <td>${p.lock ? `<span class="inline">${ext(p.lock.links?.pr, `#${p.lock.pr}`, 'plain')} ${who(p.lock.user, p.lock.links?.user, null, p.lock.links?.userAvatar)}</span>` : '<span class="muted">free</span>'}</td>
            <td class="num"><a class="plain" href="${esc(listLink('runs', { project: p.project }))}">${p.runs}</a></td>
          </tr>`;
        }), q ? 'No project matches your search.' : 'No projects yet.')}</div>`;
    },

    async run(id) {
      const r = await api(`/api/runs/${encodeURIComponent(id)}`);
      const s = summaryOf(r);
      const L = r.links || {};
      const dangerous = s ? s.changes.filter(c => c.action === 'delete' || c.action === 'replace') : [];
      return `
        <div class="detail-head">
          <a href="#runs" class="small">← All runs</a>
          <div class="page-head"><h1 class="mono">${esc(r.project)}</h1>${statusPill(r)}</div>
          <div class="meta">
            <span><b>${esc(r.kind)}</b></span>
            <span>${prLink(r)}</span>
            <span>${ext(L.commit, `<span class="mono">${esc(r.headSha.slice(0, 7))}</span>`, 'plain')}</span>
            <span>${esc(r.engine)}</span>
            <span title="${esc(when(r.startedAt))}">${ago(r.startedAt)}${r.finishedAt ? ` · took ${duration(r.startedAt, r.finishedAt)}` : ''}</span>
          </div>
          <div class="people">${runPeople(r, 'av-lg')}</div>
          ${L.pr ? `<div class="links">
            <a href="${esc(L.pr)}" target="_blank" rel="noopener noreferrer">${platformIcon(L.platform)} Pull request on ${esc(L.platform)} ↗</a>
            <a href="${esc(L.commit)}" target="_blank" rel="noopener noreferrer">${platformIcon(L.platform)} Commit ${esc(r.headSha.slice(0, 7))} ↗</a>
            <a href="${esc(L.tree)}" target="_blank" rel="noopener noreferrer">${platformIcon(L.platform)} Project files ↗</a>
          </div>` : ''}
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
        <div class="card">${table(['Project', 'Workspace', 'Pull request', 'Locked by', 'Since', ''], locks.map(l => {
          return `<tr>
            <td class="mono">${esc(l.project)}</td><td class="mono muted">${esc(l.workspace)}</td>
            <td>${prLink(l)}</td>
            <td>${who(l.user, l.links?.user, null, l.links?.userAvatar)}</td><td class="muted" title="${esc(when(l.createdAt))}">${ago(l.createdAt)}</td>
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
            <div class="card-head"><h2>${ext(d.links?.tree, `<span class="mono">${esc(d.project)}</span>`, 'plain')} <span class="muted">· ${esc(repoName(d.repo))} @ ${esc(d.branch)} · ${ext(d.links?.commit, esc(d.sha.slice(0, 7)), 'plain')}</span></h2>${driftPill(d)}</div>
            ${f.error ? `<pre class="log">${esc(f.error)}</pre>` : table(['Resource', 'What happened', 'Last changed by', 'In commit'], f.drift.map(x => `<tr>
              <td class="mono">${ext(x.links?.file, esc(x.address), 'plain')}</td><td>${esc(PAST[x.action] || x.action)} outside Terraform</td>
              <td>${x.author ? `${who(x.author.name, x.links?.author, null, x.links?.authorAvatar)}<div class="muted small">${esc(x.links?.authorLogin ? `@${x.links.authorLogin}` : x.author.email)}</div>` : '<span class="muted">unknown</span>'}</td>
              <td class="wrap">${x.author ? `${ext(x.links?.commit, `<span class="mono">${esc(x.author.sha.slice(0, 7))}</span>`, 'plain')} <span class="muted">${esc(x.author.subject)}</span>` : ''}</td>
            </tr>`), 'Nothing changed outside Terraform.')}
            <div class="card-foot">
              <span class="muted small">${f.lastApply ? `Last applied by ${who(f.lastApply.user, f.lastApply.links?.user, null, f.lastApply.links?.userAvatar)} via ${ext(f.lastApply.links?.pr, `PR #${f.lastApply.pr}`, 'plain')}` : 'Never applied through tfv'}${f.pending && Object.values(f.pending).some(Boolean) ? ` · merged but not applied: ${counts(f.pending)}` : ''}</span>
              <span class="muted small">checked ${ago(d.at)}${d.notified ? ` · notified ${d.notified.map(n => esc(n.channel)).join(', ')}` : ''}</span>
            </div>
          </div>`;
        }).join('')}`;
    },

    async audit(_arg, params) {
      const f = await api('/api/facets');
      return `
        <div class="page-head"><h1>Audit log</h1><span class="muted">Every permission decision, allowed or denied</span></div>
        <form class="filters" data-list="audit" autocomplete="off">
          <label class="f grow"><span>Search</span><input type="search" name="q" value="${esc(params.get('q') || '')}" placeholder="Person, project, repo or reason"></label>
          ${select('user', 'Person', [['', 'Anyone'], ...f.users.map(u => [u, u])], params)}
          ${select('project', 'Project', [['', 'All projects'], ...f.projects.map(x => [x, x])], params)}
          ${select('action', 'Action', [['', 'Any action'], ...f.actions.map(x => [x, x])], params)}
          ${select('result', 'Decision', [['', 'Allowed or denied'], ['allowed', 'Allowed'], ['denied', 'Denied']], params)}
          ${rangeControl(params)}
        </form>
        <div id="chips">${chips(params)}</div>
        <div class="card" id="results"><div class="empty">Loading…</div></div>`;
    },
  };

  // Who has been planning and applying, most active first.
  function peopleTable(runs) {
    const since = Date.now() - 7 * 86400e3;
    const by = new Map();
    for (const r of runs) {
      if (Date.parse(r.startedAt) < since) continue;
      const p = by.get(r.user) || { name: r.user, url: r.links?.user, avatar: r.links?.userAvatar, plans: 0, applies: 0, failed: 0, prs: new Set(), last: r.startedAt };
      p[r.kind === 'apply' ? 'applies' : 'plans']++;
      if (r.status === 'failed') p.failed++;
      p.prs.add(`${r.repo}#${r.pr}`);
      if (r.startedAt > p.last) p.last = r.startedAt;
      by.set(r.user, p);
    }
    const rows = [...by.values()].sort((a, b) => (b.plans + b.applies) - (a.plans + a.applies)).map(p => `<tr class="click" data-href="${esc(listLink('runs', { user: p.name, range: '7d' }))}">
      <td>${who(p.name, p.url, null, p.avatar)}</td>
      <td class="num">${p.plans}</td><td class="num">${p.applies}</td>
      <td class="num">${p.failed ? `<span class="pill bad">${p.failed}</span>` : '0'}</td>
      <td class="num">${p.prs.size}</td><td class="muted">${ago(p.last)}</td></tr>`);
    return table(['Person', 'Plans', 'Applies', 'Failed', 'Pull requests', 'Last active'], rows, 'Nobody has run anything this week.');
  }

  function driftPill(d) {
    if (d.status === 'error') return '<span class="pill bad">check failed</span>';
    if (d.status === 'drift') return `<span class="pill warn">${d.finding?.drift?.length || 0} drifted</span>`;
    return '<span class="pill ok">clean</span>';
  }

  // ---- result lists (runs, audit): only this part refreshes as filters change ----
  const auditRow = (a) => `<tr>
    <td class="muted" title="${esc(when(a.at))}">${ago(a.at)}</td><td>${who(a.user, a.links?.user, null, a.links?.userAvatar)}</td><td class="mono">${esc(a.action)}</td>
    <td class="mono">${projLink(a.project)}</td><td>${prLink(a)}</td>
    <td class="wrap">${a.allowed ? '<span class="pill ok">allowed</span>' : `<span class="pill bad">denied</span> <span class="muted">${esc(a.reason.replace(/`/g, ''))}</span>`}</td>
  </tr>`;
  const LISTS = {
    runs: {
      url: '/api/runs/search', keys: ['q', 'user', 'project', 'status', 'kind', 'sort'], noun: ['run', 'runs'],
      head: ['Result', 'Project', 'Changes', 'Pull request', 'People', 'Engine', 'When'], row: runRow, empty: 'No runs match these filters.',
    },
    audit: {
      url: '/api/audit/search', keys: ['q', 'user', 'project', 'action', 'result'], noun: ['decision', 'decisions'],
      head: ['When', 'User', 'Action', 'Project', 'Pull request', 'Result'], row: auditRow, empty: 'No decisions match these filters.',
    },
  };
  let listState = null;
  const loadList = async (name, params, append = false) => {
    const L = LISTS[name];
    const box = $('#results');
    if (!L || !box) return;
    const offset = append ? listState.items.length : 0;
    const q = apiParams(params, L.keys);
    q.set('limit', '50');
    q.set('offset', String(offset));
    const data = await api(`${L.url}?${q}`);
    listState = { name, total: data.total, items: append ? [...listState.items, ...data.items] : data.items };
    const more = listState.items.length < listState.total;
    box.innerHTML = `<div class="card-head"><h2>${listState.total} ${L.noun[listState.total === 1 ? 0 : 1]}</h2><span class="muted small">showing ${listState.items.length}</span></div>
      ${table(L.head, listState.items.map(L.row), L.empty)}
      ${more ? '<div class="more"><button type="button" class="ghost" data-more="1">Load more</button></div>' : ''}`;
    $('#chips').innerHTML = chips(params);
  };

  // ---- routing ------------------------------------------------------------
  let timer = null;
  const current = () => {
    const raw = location.hash.slice(1) || 'overview';
    const [path, qs] = raw.split('?');
    const [name, arg] = path.split('/');
    return { name, arg, params: new URLSearchParams(qs || '') };
  };
  const route = async () => {
    if (!me) return;
    const { name, arg, params } = current();
    const viewName = views[name] ? name : 'overview';
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === viewName));
    try {
      view.innerHTML = await (viewName === 'runs' && arg ? views.run(arg) : views[viewName](arg, params));
      if (LISTS[viewName] && !arg) await loadList(viewName, params);
      $('#refreshed').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } catch (err) {
      if (err.message !== 'unauthorized') view.innerHTML = `<div class="card"><div class="empty error">Could not load this page: ${esc(err.message)}</div></div>`;
    }
    schedule();
  };
  // Keep pages fresh. Filtered lists refresh their results only, so typing isn't interrupted;
  // run detail pages stay still so logs can be read.
  const schedule = () => {
    clearTimeout(timer);
    const { name, arg } = current();
    if (name === 'runs' && arg) return;
    timer = setTimeout(async () => {
      const c = current();
      if (LISTS[c.name] && !c.arg && $('#results')) {
        await loadList(c.name, c.params).catch(() => {});
        schedule();
      } else route();
    }, 15000);
  };

  // Filter changes rewrite the address (shareable) and reload the results.
  const setParams = (name, params, full = false) => {
    for (const [k, v] of [...params.entries()]) if (!v) params.delete(k);
    const hash = `#${name}${[...params.keys()].length ? `?${params}` : ''}`;
    if (full) { location.hash = hash; return; }
    history.replaceState(null, '', hash);
    if (LISTS[name]) loadList(name, params).catch(() => {});
    else route();
  };
  let typing = null;
  view.addEventListener('input', (e) => {
    const form = e.target.closest('form.filters');
    if (!form) return;
    const { name, params } = current();
    params.set(e.target.name, e.target.value);
    if (e.target.name === 'q') {
      clearTimeout(typing);
      typing = setTimeout(() => setParams(name, params, name === 'projects'), 300);
    } else setParams(name, params, name === 'projects');
  });
  view.addEventListener('submit', (e) => { if (e.target.closest('form.filters')) e.preventDefault(); });

  view.addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-run]');
    if (row && !e.target.closest('a,button')) { location.hash = `runs/${row.dataset.run}`; return; }
    const linkRow = e.target.closest('tr[data-href]');
    if (linkRow && !e.target.closest('a,button')) { location.hash = linkRow.dataset.href; return; }
    const range = e.target.closest('button[data-range]');
    if (range) {
      const { name, params } = current();
      params.set('range', range.dataset.range);
      if (range.dataset.range !== 'custom') { params.delete('from'); params.delete('to'); }
      document.querySelectorAll('button[data-range]').forEach(b => b.setAttribute('aria-pressed', String(b === range)));
      document.querySelector('.f.custom').hidden = range.dataset.range !== 'custom';
      setParams(name, params);
      return;
    }
    const clear = e.target.closest('button[data-clear]');
    if (clear) {
      const { name, params } = current();
      const keep = clear.dataset.clear === '*' ? new URLSearchParams(params.get('sort') ? { sort: params.get('sort') } : {}) : params;
      if (clear.dataset.clear !== '*') { keep.delete(clear.dataset.clear); if (clear.dataset.clear === 'range') { keep.delete('from'); keep.delete('to'); } }
      setParams(name, keep, true);
      return;
    }
    if (e.target.closest('button[data-more]')) {
      const { name, params } = current();
      e.target.closest('button[data-more]').disabled = true;
      await loadList(name, params, true).catch(() => {});
      return;
    }
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
    const conn = $('#connected');
    const ps = who.platforms || [];
    conn.hidden = !ps.length;
    conn.innerHTML = ps.map(p => `<span class="inline" title="tfv is connected to ${esc(p.name)}">${platformIcon(p.name, 16)} ${esc(p.name)}</span>`).join('');
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
