// teriac server dashboard: a small single-page app over the /api endpoints.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const view = $('#view');
  // An API token (kept for this tab only) or, normally, the session cookie.
  let token = null;
  try { token = sessionStorage.getItem('teriac-token'); } catch { /* storage blocked */ }
  let me = null;

  // ---- API ----------------------------------------------------------------
  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      ...opts,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'teriac',
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
  const hoursPlain = (h) => (h === null || h === undefined ? '—' : h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 2.4) / 10} days`);
  const hoursText = (h) => (h === null || h === undefined ? '—' : h < 1 ? `${Math.round(h * 60)}<small>min</small>` : h < 48 ? `${Math.round(h * 10) / 10}<small>h</small>` : `${Math.round(h / 2.4) / 10}<small>days</small>`);
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
  // Avatar: the platform picture (served by teriac), or initials if there is none.
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
      <div class="f custom"${range === 'custom' ? '' : ' hidden'}><span>From – to</span>${dateTrigger('filters', params.get('from'), params.get('to'))}</div>`;
  };
  const LABELS = {
    q: 'Search', user: 'Person', project: 'Project', status: 'Result', kind: 'Type', action: 'Action', result: 'Decision', range: 'When', sort: 'Sort',
    rule: 'Rule', severity: 'Severity', mode: 'Mode',
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

  // ---- date-range picker ------------------------------------------------------
  const CAL_ICON = '<svg class="ni" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.8v2.4M10.5 1.8v2.4"/></svg>';
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parseDay = (s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00`) : null);
  const longDay = (s) => (s ? parseDay(s).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const dateTrigger = (kind, from, to) => `<button type="button" class="date-trigger" data-picker="${kind}" data-from="${esc(from || '')}" data-to="${esc(to || '')}" aria-haspopup="dialog">
      ${CAL_ICON}<span>${from && to ? `${esc(longDay(from))} <span class="muted">–</span> ${esc(longDay(to))}` : '<span class="muted">Pick dates</span>'}</span>
      <svg class="ni chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg></button>`;

  const picker = { el: null, trigger: null, from: null, to: null, month: null, onApply: null };
  const PRESETS = [
    ['Today', 0, 0], ['Yesterday', 1, 1], ['Last 7 days', 6, 0], ['Last 14 days', 13, 0], ['Last 30 days', 29, 0],
    ['This month', 'tm'], ['Last month', 'lm'], ['Last 90 days', 89, 0],
  ];
  const presetRange = (p) => {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    if (p[1] === 'tm') return [new Date(now.getFullYear(), now.getMonth(), 1), now];
    if (p[1] === 'lm') return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 0)];
    const day = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
    return [day(p[1]), day(p[2])];
  };
  const monthGrid = (first) => {
    const today = iso(new Date());
    const lead = (first.getDay() + 6) % 7; // weeks start on Monday
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<span class="cal-pad"></span>');
    for (let n = 1; n <= days; n++) {
      const d = iso(new Date(first.getFullYear(), first.getMonth(), n));
      const lo = picker.from, hi = picker.to ?? picker.hover ?? picker.from;
      const [a, b] = lo && hi && hi < lo ? [hi, lo] : [lo, hi];
      const cls = [
        'cal-day',
        d === today && 'today',
        a && b && d > a && d < b && 'in',
        d === a && 'start', d === b && 'end',
      ].filter(Boolean).join(' ');
      cells.push(`<button type="button" class="${cls}" data-day="${d}"${d > today ? ' disabled' : ''} aria-pressed="${d === a || d === b}" aria-label="${esc(parseDay(d).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}">${n}</button>`);
    }
    return `<div class="cal-month">
      <div class="cal-title">${esc(first.toLocaleDateString([], { month: 'long', year: 'numeric' }))}</div>
      <div class="cal-grid">${['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(w => `<span class="cal-wd">${w}</span>`).join('')}${cells.join('')}</div>
    </div>`;
  };
  const renderPicker = () => {
    const m = picker.month;
    const next = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    const atEnd = next > new Date();
    const [a, b] = picker.from && picker.to ? [picker.from, picker.to].sort() : [picker.from, null];
    const nDays = a && b ? Math.round((parseDay(b) - parseDay(a)) / 864e5) + 1 : 0;
    picker.el.innerHTML = `
      <div class="cal-presets">${PRESETS.map((p, i) => `<button type="button" data-preset="${i}">${esc(p[0])}</button>`).join('')}</div>
      <div class="cal-main">
        <div class="cal-nav">
          <button type="button" class="ghost small icon" data-cal-move="-1" aria-label="Previous month">‹</button>
          <button type="button" class="ghost small icon" data-cal-move="1" aria-label="Next month"${atEnd ? ' disabled' : ''}>›</button>
        </div>
        <div class="cal-months">${monthGrid(m)}${monthGrid(next)}</div>
        <div class="cal-foot">
          <span class="small">${a && b ? `<b>${esc(longDay(a))}</b> – <b>${esc(longDay(b))}</b> <span class="muted">· ${nDays} day${nDays === 1 ? '' : 's'}</span>`
            : a ? `<b>${esc(longDay(a))}</b> <span class="muted">– pick the end date</span>` : '<span class="muted">Pick a start date</span>'}</span>
          <span class="cal-actions"><button type="button" class="ghost small" data-cal-cancel>Cancel</button><button type="button" class="small" data-cal-apply${a && b ? '' : ' disabled'}>Apply</button></span>
        </div>
      </div>`;
  };
  const closePicker = () => {
    picker.el?.remove();
    picker.el = null;
    picker.trigger?.setAttribute('aria-expanded', 'false');
    picker.trigger?.focus();
    picker.trigger = null;
  };
  const openPicker = (trigger, onApply) => {
    closePicker();
    picker.trigger = trigger;
    picker.onApply = onApply;
    picker.from = trigger.dataset.from || null;
    picker.to = trigger.dataset.to || null;
    picker.hover = null;
    const anchor = parseDay(picker.to) || new Date();
    // Show the end date's month on the right.
    picker.month = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
    const el = document.createElement('div');
    el.className = 'cal';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Choose a date range');
    picker.el = el;
    renderPicker();
    document.body.appendChild(el);
    trigger.setAttribute('aria-expanded', 'true');
    const r = trigger.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth));
    el.style.left = `${left}px`;
    el.style.top = `${r.bottom + window.scrollY + 6}px`;
    el.querySelector('.cal-day.start, .cal-day:not([disabled])')?.focus();
    el.addEventListener('click', (e) => {
      const day = e.target.closest('[data-day]');
      if (day) {
        if (!picker.from || picker.to) { picker.from = day.dataset.day; picker.to = null; }
        else { picker.to = day.dataset.day; if (picker.to < picker.from) [picker.from, picker.to] = [picker.to, picker.from]; }
        renderPicker();
        picker.el.querySelector(`[data-day="${day.dataset.day}"]`)?.focus();
        return;
      }
      const preset = e.target.closest('[data-preset]');
      if (preset) {
        const [a, b] = presetRange(PRESETS[Number(preset.dataset.preset)]);
        picker.from = iso(a); picker.to = iso(b);
        picker.month = new Date(b.getFullYear(), b.getMonth() - 1, 1);
        renderPicker();
        return;
      }
      const move = e.target.closest('[data-cal-move]');
      if (move) { picker.month = new Date(picker.month.getFullYear(), picker.month.getMonth() + Number(move.dataset.calMove), 1); renderPicker(); return; }
      if (e.target.closest('[data-cal-cancel]')) return closePicker();
      if (e.target.closest('[data-cal-apply]')) {
        const [a, b] = [picker.from, picker.to].sort();
        const apply = picker.onApply;
        closePicker();
        apply(a, b);
      }
    });
    // While choosing the end, preview the range under the pointer.
    el.addEventListener('mouseover', (e) => {
      const day = e.target.closest('[data-day]');
      if (!day || !picker.from || picker.to || picker.hover === day.dataset.day) return;
      picker.hover = day.dataset.day;
      el.querySelectorAll('.cal-day').forEach(b => {
        const d = b.dataset.day;
        const [a, z] = [picker.from, picker.hover].sort();
        b.classList.toggle('in', d > a && d < z);
        b.classList.toggle('end', d === z && d !== picker.from);
        b.classList.toggle('start', d === a);
      });
    });
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && picker.el) closePicker(); });
  document.addEventListener('mousedown', (e) => {
    if (picker.el && !picker.el.contains(e.target) && !picker.trigger?.contains(e.target)) closePicker();
  });

  // ---- pages ----------------------------------------------------------------
  const PAGE_SIZES = [10, 25, 50, 100];
  let savedSize = null;
  try { savedSize = Number(localStorage.getItem('teriac-page-size')); } catch { /* ignore */ }
  const pageOf = (params) => {
    const size = PAGE_SIZES.includes(Number(params.get('size'))) ? Number(params.get('size')) : PAGE_SIZES.includes(savedSize) ? savedSize : 25;
    const page = Math.max(1, Math.floor(Number(params.get('page')) || 1));
    return { size, page, offset: (page - 1) * size };
  };
  // "26–50 of 420 · Rows per page [25] · ‹ Previous · Page 2 of 17 · Next ›"
  const pager = (total, params) => {
    const { size, page } = pageOf(params);
    const pages = Math.max(1, Math.ceil(total / size));
    const first = total ? (page - 1) * size + 1 : 0;
    const last = Math.min(total, page * size);
    return `<div class="pager">
      <span class="muted small">${fmtN(first)}–${fmtN(last)} of ${fmtN(total)}</span>
      <label class="small muted">Rows per page <select data-size>${PAGE_SIZES.map(n => `<option value="${n}"${n === size ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <span class="pages">
        <button type="button" class="ghost small" data-page="${page - 1}"${page <= 1 ? ' disabled' : ''} aria-label="Previous page">‹ Previous</button>
        <span class="small">Page ${fmtN(Math.min(page, pages))} of ${fmtN(pages)}</span>
        <button type="button" class="ghost small" data-page="${page + 1}"${page >= pages ? ' disabled' : ''} aria-label="Next page">Next ›</button>
      </span>
    </div>`;
  };
  const fmtN = (n) => Number(n || 0).toLocaleString();

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
        <div class="page-head"><h1>Overview</h1><span class="muted">Everything teriac did across your repos</span></div>
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
        <div class="page-head"><h1>Projects</h1><span class="muted">Every project teriac has planned, with who touched it last</span></div>
        <form class="filters" data-list="projects" autocomplete="off">
          <label class="f grow"><span>Search</span><input type="search" name="q" value="${esc(params.get('q') || '')}" placeholder="Project, repo or person"></label>
          ${select('sort', 'Sort', [['recent', 'Recently active'], ['name', 'Name A–Z'], ['runs', 'Most runs']], params)}
        </form>
        <div class="card">${table(['Project', 'Repository', 'Last run', 'By', 'Last applied', 'Lock', 'Runs'], list.slice(pageOf(params).offset, pageOf(params).offset + pageOf(params).size).map(p => {
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
        }), q ? 'No project matches your search.' : 'No projects yet.')}${list.length ? pager(list.length, params) : ''}</div>`;
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
            ${r.usage ? (r.usage.quick ? '<span class="muted">too quick to measure CPU and memory</span>'
              : `<span title="Terraform and its providers, together">peak memory <b>${bytesText(r.usage.peakMemory)}</b> · CPU <b>${secsText(r.usage.cpuSeconds)}</b> · ${r.usage.peakProcesses} processes</span>`) : ''}
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
            <td>${adminButton('Unlock', `data-unlock='${esc(JSON.stringify({ repo: l.repo, project: l.project, workspace: l.workspace, pr: l.pr, user: l.user, createdAt: l.createdAt, prUrl: l.links?.pr ?? null }))}'`)}</td>
          </tr>`;
        }), 'No projects are locked.')}</div>`;
    },

    async access() {
      const g = await api('/api/grants');
      const PERMS = [['apply', 'apply'], ['apply_destroy', 'apply with destroys'], ['unlock', 'unlock'], ['state_write', 'import / taint'], ['state_remove', 'state rm / mv']];
      const SKIPS = [['approvals', 'approvals'], ['freeze', 'change freezes'], ['protected', 'protected resources'], ['policy', 'enforced policies']];
      const status = (x) => x.revokedAt ? '<span class="pill">revoked</span>' : Date.parse(x.expiresAt) <= Date.now() ? '<span class="pill">expired</span>' : '<span class="pill bad">active</span>';
      const scope = (x) => `${x.actions.map(a => `<span class="pill">${esc(a)}</span>`).join(' ')} <span class="muted">on</span> <span class="mono">${x.projects.length ? x.projects.map(esc).join(', ') : 'every project'}</span>${x.repo !== '*' ? ` <span class="muted">in ${esc(x.repo)}</span>` : ''}`;
      const canRevoke = g.canGrant || isAdmin();
      const row = (x, live) => `<tr>
          <td class="mono">#${x.id}</td><td><b>${esc(x.user)}</b></td><td class="wrap">${scope(x)}</td>
          <td>${x.bypass.length ? x.bypass.map(b => `<span class="pill warn">${esc(b)}</span>`).join(' ') : '<span class="muted">—</span>'}</td>
          <td class="wrap">${esc(x.reason)}</td><td>${esc(x.grantedBy)}</td>
          <td title="${esc(when(x.expiresAt))}">${live ? `ends ${esc(new Date(x.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : status(x)}</td>
          <td class="muted">${x.usedAt ? `used ${esc(ago(x.usedAt))}` : 'not used'}</td>
          <td>${live && canRevoke ? `<button class="ghost small" type="button" data-revoke="${x.id}" data-user="${esc(x.user)}">Revoke</button>` : ''}</td>
        </tr>`;
      const form = g.canGrant ? `
        <form class="filters grant" autocomplete="off">
          <label class="f"><span>For (username)</span><input id="g-user" name="user" required placeholder="e.g. octocat"></label>
          <label class="f"><span>Repository</span><input id="g-repo" name="repo" placeholder="all, or github.com/acme/infra"></label>
          <label class="f grow"><span>Projects</span><input id="g-projects" name="projects" placeholder="all, or prod/**, envs/prod"></label>
          <label class="f"><span>Hours</span><input id="g-hours" name="hours" type="number" min="1" max="${g.maxHours}" value="1" required></label>
          <fieldset class="f checks"><span>Permissions</span><div>${PERMS.map(([v, l], i) => `<label><input type="checkbox" name="actions" value="${v}" ${i === 0 ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div></fieldset>
          <fieldset class="f checks"><span>May skip</span><div>${SKIPS.map(([v, l]) => `<label><input type="checkbox" name="bypass" value="${v}"> ${esc(l)}</label>`).join('')}</div></fieldset>
          <label class="f grow"><span>Reason (goes to the audit log)</span><input id="g-reason" name="reason" required minlength="10" placeholder="e.g. INC-1234: roll back the broken load balancer"></label>
          <button type="submit">Grant access</button>
        </form>` : '';
      return `
        <div class="page-head"><h1>Access</h1><span class="muted">Emergency access: a permission for a few hours, removed automatically</span></div>
        ${!g.enabled ? `<div class="card"><div class="empty">Emergency access is off. Add <code>break_glass:</code> with <code>grantors</code> to repos.yaml to turn it on.</div></div>` : form || '<div class="card"><div class="empty">You can see grants here. Only grantors (break_glass.grantors in repos.yaml) can give access.</div></div>'}
        <div class="card"><div class="card-head"><h2>Active</h2><span class="muted small">${fmtN(g.active.length)}</span></div>
          ${table(['', 'For', 'Permission', 'Skips', 'Reason', 'Granted by', 'Expires', 'Used', ''], g.active.map(x => row(x, true)), 'Nobody has emergency access right now.')}</div>
        <div class="card"><div class="card-head"><h2>History</h2></div>
          ${table(['', 'For', 'Permission', 'Skips', 'Reason', 'Granted by', 'Status', 'Used', ''], g.recent.map(x => row(x, false)), 'No emergency access has been given.')}</div>`;
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
          </tr>`), 'No drift schedules. Add one under <code>drift:</code> in repos.yaml or a repo\'s teriac.yaml.')}
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
              <span class="muted small">${f.lastApply ? `Last applied by ${who(f.lastApply.user, f.lastApply.links?.user, null, f.lastApply.links?.userAvatar)} via ${ext(f.lastApply.links?.pr, `PR #${f.lastApply.pr}`, 'plain')}` : 'Never applied through teriac'}${f.pending && Object.values(f.pending).some(Boolean) ? ` · merged but not applied: ${counts(f.pending)}` : ''}</span>
              <span class="muted small">checked ${ago(d.at)}${d.notified ? ` · notified ${d.notified.map(n => esc(n.channel)).join(', ')}` : ''}</span>
            </div>
          </div>`;
        }).join('')}`;
    },

    async audit(_arg, params) {
      const f = await api('/api/facets');
      const tab = params.get('tab') === 'policy' ? 'policy' : 'decisions';
      const tabs = `<div class="tabs" role="tablist">
        <a role="tab" aria-selected="${tab === 'decisions'}" href="#audit">Decisions</a>
        <a role="tab" aria-selected="${tab === 'policy'}" href="#audit?tab=policy">Policy findings</a></div>`;
      if (tab === 'policy') {
        return `
          <div class="page-head"><h1>Audit</h1><span class="muted">Policy findings on every plan, in audit and enforce mode</span></div>
          ${tabs}
          <form class="filters" data-list="policy" autocomplete="off">
            <input type="hidden" name="tab" value="policy">
            <label class="f grow"><span>Search</span><input type="search" name="q" value="${esc(params.get('q') || '')}" placeholder="Rule, resource, message, project or person"></label>
            ${select('project', 'Project', [['', 'All projects'], ...f.projects.map(x => [x, x])], params)}
            ${select('rule', 'Rule', [['', 'Any rule'], ...f.rules.map(x => [x, x])], params)}
            ${select('severity', 'Severity', [['', 'Any severity'], ['critical', 'Critical'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']], params)}
            ${select('mode', 'Mode', [['', 'Audit or enforce'], ['enforce', 'Enforced (blocking)'], ['audit', 'Audit only']], params)}
            ${rangeControl(params)}
          </form>
          <div id="chips">${chips(params)}</div>
          <div class="card" id="results"><div class="empty">Loading…</div></div>`;
      }
      return `
        <div class="page-head"><h1>Audit</h1><span class="muted">Every permission decision, allowed or denied</span></div>
        ${tabs}
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

    async metrics(_arg, params) {
      // Last 7/30/90 days, or a custom range (dates inclusive, in the viewer's time zone).
      const custom = params.get('days') === 'custom';
      const days = custom ? 'custom' : ['7', '30', '90'].includes(params.get('days')) ? params.get('days') : '30';
      const today = new Date().toISOString().slice(0, 10);
      const fromDay = params.get('from') || new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
      const toDay = params.get('to') || today;
      const startOf = (d) => new Date(`${d}T00:00`);
      const q = custom
        ? `from=${encodeURIComponent(startOf(fromDay).toISOString())}&to=${encodeURIComponent(new Date(startOf(toDay).getTime() + 864e5).toISOString())}`
        : `days=${days}`;
      const m = await api(`/api/stats?${q}`);
      const period = custom ? `${dayLabel(fromDay)} – ${dayLabel(toDay)}` : `${days} days`;
      const t = m.totals;
      const pct = t.runs ? Math.round(((t.runs - t.failed) / t.runs) * 1000) / 10 : null;
      const res = m.resources;
      const sev = Object.fromEntries(m.policy.bySeverity.map(x => [x.severity, x.n]));
      const findings = m.policy.bySeverity.reduce((a, x) => a + x.n, 0);
      const denied = m.decisions.denied.reduce((a, x) => a + x.n, 0);
      const drift = Object.fromEntries(m.drift.map(x => [x.status, x.n]));
      const series = custom ? dailySeriesBetween(m.daily, fromDay, toDay) : dailySeries(m.daily, Number(days));
      const seg = `<div class="period">
        <div class="seg" role="group" aria-label="Period">${[['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['custom', 'Custom']].map(([v, l]) =>
          `<button type="button" data-days="${v}" aria-pressed="${v === days}">${l}</button>`).join('')}</div>
        ${custom ? dateTrigger('metrics', fromDay, toDay) : ''}
      </div>`;
      return `
        <div class="page-head"><h1>Metrics</h1>${seg}</div>
        <div class="tiles hero">
          ${tile(fmt(t.runs), 'runs', `${fmt(t.plans)} plans · ${fmt(t.applies)} applies`, custom ? listLink('runs', { range: 'custom', from: fromDay, to: toDay }) : listLink('runs', { range: days === '7' ? '7d' : '30d' }))}
          ${tile(pct === null ? '—' : `${pct}<small>%</small>`, 'succeeded', `${fmt(t.failed)} failed`, listLink('runs', { status: 'failed' }), t.failed ? 'bad' : '')}
          ${tile(fmt(res.added + res.changed + res.destroyed), 'resources changed by applies', `+${fmt(res.added)} · ~${fmt(res.changed)} · −${fmt(res.destroyed)}`)}
          ${tile(secsText(m.timing.plan.p50), 'median plan time', `p95 ${secsText(m.timing.plan.p95)}`)}
          ${tile(secsText(m.timing.apply.p50), 'median apply time', `p95 ${secsText(m.timing.apply.p95)}`)}
          ${tile(fmt(t.prs), 'pull requests', `${fmt(t.users)} people · ${fmt(t.projects)} projects`)}
        </div>
        ${(() => {
          const d = m.delivery;
          if (!d) return '';
          return `<div class="card"><div class="card-head"><h2>Delivery</h2><span class="muted small">how fast and how safely changes reach infrastructure</span></div>
            <div class="tiles hero inner">
              ${tile(hoursText(d.leadTime.p50), 'median PR to applied', d.leadTime.count ? `p90 ${hoursPlain(d.leadTime.p90)} · ${fmt(d.leadTime.count)} changes` : 'no applies yet')}
              ${tile(d.failureRate === null ? '—' : `${d.failureRate}<small>%</small>`, 'applies that failed', `${fmt(d.applies)} applies`, listLink('runs', { kind: 'apply', status: 'failed' }), d.failureRate > 15 ? 'bad' : '')}
              ${tile(hoursText(d.recovery.p50), 'median time to fix a failed apply', `${fmt(d.recovery.count)} fixed`)}
              ${tile(fmt(d.appliesPerWeek), 'applies per week', `over ${esc(period)}`)}
            </div><div class="pad-b"></div></div>`;
        })()}
        <div class="card viz">
          <div class="card-head"><h2>Runs per day</h2><span class="muted small">hover a day for details</span></div>
          <div class="legend"><span><i class="key s1"></i>Plans</span><span><i class="key s2"></i>Applies</span></div>
          <div class="chart">${columnChart(series, [['plans', 's1', 'Plans'], ['applies', 's2', 'Applies']], 'Runs per day')}</div>
          ${tableView(['Day', 'Plans', 'Applies', 'Failed'], series.map(d => [d.day, d.plans, d.applies, d.failed]))}
        </div>
        <div class="card viz">
          <div class="card-head"><h2>Failed runs per day</h2><span class="muted small">${fmt(t.failed)} in ${esc(period)}</span></div>
          <div class="chart">${columnChart(series, [['failed', 'sbad', 'Failed']], 'Failed runs per day', 110)}</div>
          ${tableView(['Day', 'Failed'], series.filter(d => d.failed).map(d => [d.day, d.failed]))}
        </div>
        <div class="grid3">
          <div class="card viz"><div class="card-head"><h2>Busiest projects</h2><a href="#projects">All projects</a></div>
            ${bars(m.projects.map(p => ({ label: `<span class="mono">${projLink(p.project)}</span>`, value: p.runs, note: p.failed ? `${p.failed} failed` : '' })), 'No runs in this period.')}</div>
          <div class="card viz"><div class="card-head"><h2>Most active people</h2></div>
            ${bars(m.people.map(p => ({ label: `<a class="plain" href="${esc(listLink('runs', { user: p.user }))}">${who(p.user)}</a>`, value: p.runs, note: `${p.plans} plans · ${p.applies} applies` })), 'Nobody has run anything in this period.')}</div>
          <div class="card viz"><div class="card-head"><h2>Engines</h2></div>
            ${bars(m.engines.map(e => ({ label: esc(e.engine), value: e.n })), 'No runs in this period.')}</div>
        </div>
        <div class="grid3">
          <div class="card"><div class="card-head"><h2>Run times</h2></div>
            ${table(['', 'Runs', 'Median', 'p95', 'Slowest'], ['plan', 'apply'].map(k => {
              const x = m.timing[k];
              return `<tr><td><b>${k === 'plan' ? 'Plans' : 'Applies'}</b></td><td class="num">${fmt(x.count)}</td><td class="num">${secsText(x.p50)}</td><td class="num">${secsText(x.p95)}</td><td class="num">${secsText(x.max)}</td></tr>`;
            }), 'No finished runs yet.')}</div>
          <div class="card viz"><div class="card-head"><h2>Policy findings</h2><a href="${esc(listLink('audit', { tab: 'policy' }))}">${fmt(findings)} findings</a></div>
            ${bars(['critical', 'high', 'medium', 'low'].filter(k => sev[k]).map(k => ({ label: `<span class="pill ${SEV_PILL[k] ?? ''}">${k}</span>`, value: sev[k], cls: `sev-${k}` })), 'No policy findings in this period.')}
            ${m.policy.topRules.length ? `<div class="card-foot"><span class="muted small">Top rules: ${m.policy.topRules.slice(0, 4).map(x => `<b>${esc(x.rule)}</b> ${x.n}`).join(' · ')}</span></div>` : ''}</div>
          <div class="card viz"><div class="card-head"><h2>Denied decisions</h2><a href="${esc(listLink('audit', { result: 'denied' }))}">${fmt(denied)} of ${fmt(m.decisions.total)}</a></div>
            ${bars(m.decisions.denied.map(x => ({ label: `<span class="mono">${esc(x.action)}</span>`, value: x.n, cls: 'sev-high' })), 'Nothing was denied in this period.')}</div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Resource usage of runs</h2><span class="muted small">${m.usage.runs ? `${fmt(m.usage.runs)} runs measured · CPU and memory of Terraform and its providers` : 'measured on Linux (the container image)'}</span></div>
          ${m.usage.runs ? `<div class="tiles hero inner">
              ${tile(bytesText(m.usage.memory.p50), 'median peak memory', `p95 ${bytesText(m.usage.memory.p95)} · max ${bytesText(m.usage.memory.max)}`)}
              ${tile(secsText(m.usage.cpu.p50), 'median CPU per run', `p95 ${secsText(m.usage.cpu.p95)}`)}
              ${tile(secsText(m.usage.cpu.total), 'CPU used in total', period)}
            </div>
            ${table(['Heaviest runs', 'Pull request', 'Type', 'Peak memory', 'CPU', 'Processes', 'Took', 'By'], m.usage.heaviest.map(r => `<tr class="click" data-run="${r.id}">
              <td class="mono">${projLink(r.project)}</td>
              <td>${esc(repoName(r.repo))} <span class="muted">#${r.pr}</span></td>
              <td>${esc(r.kind)}${r.status === 'failed' ? ' <span class="pill bad">failed</span>' : ''}</td>
              <td class="num"><b>${bytesText(r.usage.peakMemory)}</b></td>
              <td class="num">${secsText(r.usage.cpuSeconds)}</td>
              <td class="num">${fmt(r.usage.peakProcesses)}</td>
              <td class="num">${secsText(r.seconds)}</td>
              <td>${who(r.user)}</td></tr>`), '')}`
            : '<div class="empty">No runs measured yet in this period.</div>'}
        </div>
        <div class="grid3">
          <div class="card"><div class="card-head"><h2>Locks and drift</h2></div>
            <div class="kv">
              <span>Projects locked now</span><span><a class="plain" href="#locks">${fmt(m.locks.n)}</a></span>
              <span>Oldest lock</span><span>${m.locks.oldest ? ago(m.locks.oldest) : '—'}</span>
              <span>Plans that destroy</span><span>${fmt(t.destroying)}</span>
              <span>Drift checks</span><span>${fmt((drift.clean || 0) + (drift.drift || 0) + (drift.error || 0))}</span>
              <span>Found drift</span><span>${drift.drift ? `<span class="pill warn">${fmt(drift.drift)}</span>` : '0'}</span>
              <span>Checks that failed</span><span>${drift.error ? `<span class="pill bad">${fmt(drift.error)}</span>` : '0'}</span>
            </div></div>
          <div class="card"><div class="card-head"><h2>Server</h2><a href="/metrics" target="_blank" rel="noopener">Prometheus ↗</a></div>
            <div class="kv">
              <span>Version</span><span class="mono">${esc(m.server.version)}</span>
              <span>Node.js</span><span class="mono">${esc(m.server.node)}</span>
              <span>Up for</span><span>${secsText(m.server.uptime)} <span class="muted small">since ${esc(when(m.server.startedAt))}</span></span>
              <span>Memory</span><span>${(m.server.memory / 1048576).toFixed(0)} MB</span>
              <span>Runs going now</span><span>${m.server.queue ? fmt(m.server.queue.active) : '—'}</span>
              <span>Runs waiting</span><span>${m.server.queue ? fmt(m.server.queue.waiting) : '—'}</span>
              <span>Repositories</span><span>${fmt(t.repos)}</span>
            </div></div>
        </div>`;
    },
  };

  // ---- metrics helpers ------------------------------------------------------
  const fmt = (n) => Number(n || 0).toLocaleString();
  const secsText = (s) => {
    if (s === null || s === undefined) return '—';
    if (s > 0 && s < 10) return `${Math.round(s * 10) / 10}s`;
    s = Math.round(s);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  };
  const bytesText = (b) => {
    if (b === null || b === undefined) return '—';
    if (b < 1048576) return `${Math.round(b / 1024)} KB`;
    if (b < 1073741824) return `${Math.round(b / 1048576)} MB`;
    return `${(b / 1073741824).toFixed(1)} GB`;
  };
  const tile = (n, k, sub, href, cls = '') => {
    const inner = `<span class="n">${n}</span><span class="k">${esc(k)}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}`;
    return href ? `<a class="tile ${cls}" href="${esc(href)}">${inner}</a>` : `<div class="tile ${cls}">${inner}</div>`;
  };
  // One entry per day of the period, zeros included, oldest first.
  const dailySeries = (rows, days) => {
    const out = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      out.set(d, { day: d, plans: 0, applies: 0, failed: 0 });
    }
    for (const r of rows) {
      const d = out.get(r.day);
      if (!d) continue;
      d[r.kind === 'apply' ? 'applies' : 'plans'] += r.n;
      if (r.status === 'failed') d.failed += r.n;
    }
    return [...out.values()];
  };
  // Every day from `from` to `to` (inclusive), zeros included. Capped so a long range stays readable.
  const dailySeriesBetween = (rows, from, to) => {
    const out = new Map();
    const start = new Date(`${from}T12:00:00Z`).getTime();
    const end = new Date(`${to}T12:00:00Z`).getTime();
    for (let t = start; t <= end && out.size < 1100; t += 864e5) {
      const d = new Date(t).toISOString().slice(0, 10);
      out.set(d, { day: d, plans: 0, applies: 0, failed: 0 });
    }
    for (const r of rows) {
      const d = out.get(r.day);
      if (!d) continue;
      d[r.kind === 'apply' ? 'applies' : 'plans'] += r.n;
      if (r.status === 'failed') d.failed += r.n;
    }
    return [...out.values()];
  };
  const dayLabel = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  // Stacked columns, one per day: thin marks, 2px gaps, rounded top, recessive grid.
  let chartData = [];
  const columnChart = (series, keys, label, height = 190) => {
    // Drawn at the page's real width, so text stays 11px instead of scaling with the SVG.
    const W = Math.max(320, Math.round(view.clientWidth - 34)), H = height, L = 30, B = 22, T = 8;
    const totals = series.map(d => keys.reduce((a, [k]) => a + d[k], 0));
    const top = Math.max(1, ...totals);
    const step = top <= 4 ? 1 : Math.ceil(top / 4 / (top > 40 ? 10 : 1)) * (top > 40 ? 10 : 1);
    const max = Math.ceil(top / step) * step;
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const slot = (W - L) / series.length;
    const bw = Math.max(2, Math.min(28, slot - 2));
    const id = chartData.push({ series, keys }) - 1;
    let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;
    for (let v = 0; v <= max; v += step) {
      out += `<line class="gridline" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    const every = Math.ceil(series.length / Math.max(3, Math.floor(W / 90)));
    series.forEach((d, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      let base = 0;
      let marks = '';
      keys.forEach(([k, cls], j) => {
        const v = d[k];
        if (!v) return;
        const y0 = y(base), y1 = y(base + v);
        const isTop = keys.slice(j + 1).every(([k2]) => !d[k2]);
        const h = Math.max(1, y0 - y1 - (base > 0 ? 2 : 0)); // 2px surface gap between stacked segments
        const yy = y0 - (base > 0 ? 2 : 0) - h;
        const r = isTop ? Math.min(4, bw / 2, h) : 0;
        marks += r
          ? `<path class="col ${cls}" d="M${x},${yy + h} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${yy + h} Z"/>`
          : `<rect class="col ${cls}" x="${x}" y="${yy}" width="${bw}" height="${h}"/>`;
        base += v;
      });
      out += `<rect class="hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" data-chart="${id}" data-i="${i}"/><g>${marks}</g>`;
      if (i % every === 0) out += `<text class="axis" x="${L + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${esc(dayLabel(d.day))}</text>`;
    });
    return `${out}</svg>`;
  };
  // Horizontal bars in HTML; widths are applied after render (no inline styles under the CSP).
  const bars = (rows, empty) => {
    if (!rows.length) return `<div class="empty">${empty}</div>`;
    const max = Math.max(...rows.map(r => r.value));
    return `<div class="bars">${rows.map(r => `<div class="bar-row"><span class="label">${r.label}</span>
      <span class="bar-track"><span class="bar-fill ${r.cls || ''}" data-w="${Math.round((r.value / max) * 1000) / 10}"></span></span>
      <span class="val">${fmt(r.value)}${r.note ? ` <small>${esc(r.note)}</small>` : ''}</span></div>`).join('')}</div>`;
  };
  const tableView = (head, rows) => rows.length
    ? `<details class="table-view"><summary>Show as a table</summary>${table(head, rows.map(r => `<tr>${r.map(c => `<td class="num">${esc(c)}</td>`).join('')}</tr>`), '')}</details>` : '';
  const sizeBars = () => document.querySelectorAll('.bar-fill[data-w]').forEach(el => { el.style.width = `${el.dataset.w}%`; });

  // Tooltip for the day columns.
  const tip = $('#tip');
  view.addEventListener('mousemove', (e) => {
    const hit = e.target.closest?.('rect.hit');
    document.querySelectorAll('.chart g.on').forEach(g => g.classList.remove('on'));
    if (!hit) { tip.hidden = true; return; }
    const { series, keys } = chartData[Number(hit.dataset.chart)] || {};
    const d = series?.[Number(hit.dataset.i)];
    if (!d) return;
    hit.nextElementSibling?.classList.add('on');
    tip.innerHTML = `<b>${esc(new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}</b>${
      keys.map(([k, cls, name]) => `<div class="row"><span><i class="key ${cls}"></i>${esc(name)}</span><b>${fmt(d[k])}</b></div>`).join('')}${
      keys.some(([k]) => k === 'failed') ? '' : `<div class="row"><span>Failed</span><b>${fmt(d.failed)}</b></div>`}`;
    tip.hidden = false;
    const x = Math.min(window.innerWidth - tip.offsetWidth - 12, e.clientX + 14);
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(8, e.clientY - tip.offsetHeight - 12)}px`;
  });
  view.addEventListener('mouseleave', () => { tip.hidden = true; });

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
  const SEV_PILL = { critical: 'bad', high: 'bad', medium: 'warn', low: '' };
  const findingRow = (x) => `<tr>
    <td class="muted" title="${esc(when(x.at))}">${ago(x.at)}</td>
    <td><span class="pill ${SEV_PILL[x.severity] ?? ''}">${esc(x.severity)}</span></td>
    <td><b>${esc(x.rule)}</b></td>
    <td class="mono">${projLink(x.project)}</td>
    <td class="mono wrap">${esc(x.address)}</td>
    <td class="wrap">${esc(String(x.message).split('\n')[0].slice(0, 240))}</td>
    <td>${x.mode === 'enforce' ? '<span class="pill bad">enforced</span>' : '<span class="pill">audit</span>'}</td>
    <td>${prLink(x)}</td>
    <td>${who(x.user, x.links?.user, null, x.links?.userAvatar)}</td>
  </tr>`;
  const LISTS = {
    runs: {
      url: '/api/runs/search', keys: ['q', 'user', 'project', 'status', 'kind', 'sort'], noun: ['run', 'runs'],
      head: ['Result', 'Project', 'Changes', 'Pull request', 'People', 'Engine', 'When'], row: runRow, empty: 'No runs match these filters.',
    },
    policy: {
      url: '/api/policy/search', keys: ['q', 'project', 'rule', 'severity', 'mode'], noun: ['finding', 'findings'],
      head: ['When', 'Severity', 'Rule', 'Project', 'Resource', 'Finding', 'Mode', 'Pull request', 'Planned by'], row: findingRow, empty: 'No policy findings match these filters.',
    },
    audit: {
      url: '/api/audit/search', keys: ['q', 'user', 'project', 'action', 'result'], noun: ['decision', 'decisions'],
      head: ['When', 'User', 'Action', 'Project', 'Pull request', 'Result'], row: auditRow, empty: 'No decisions match these filters.',
    },
  };
  let listState = null;
  // The Audit page shows decisions or policy findings, depending on its tab.
  const listName = (view, params) => (view === 'audit' && params.get('tab') === 'policy' ? 'policy' : LISTS[view] ? view : null);
  const loadList = async (name, params) => {
    const L = LISTS[name];
    const box = $('#results');
    if (!L || !box) return;
    const { size, offset } = pageOf(params);
    const q = apiParams(params, L.keys);
    q.set('limit', String(size));
    q.set('offset', String(offset));
    const data = await api(`${L.url}?${q}`);
    listState = { name, total: data.total, items: data.items };
    box.innerHTML = `<div class="card-head"><h2>${fmtN(data.total)} ${L.noun[data.total === 1 ? 0 : 1]}</h2></div>
      ${table(L.head, data.items.map(L.row), L.empty)}
      ${data.total ? pager(data.total, params) : ''}`;
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
    if (picker.el) closePicker(); // a popup belongs to the page it was opened on
    const { name, arg, params } = current();
    const viewName = views[name] ? name : 'overview';
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === viewName));
    try {
      chartData = [];
      tip.hidden = true;
      view.innerHTML = await (viewName === 'runs' && arg ? views.run(arg) : views[viewName](arg, params));
      sizeBars();
      const list = listName(viewName, params);
      if (list && !arg) await loadList(list, params);
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
      const list = listName(c.name, c.params);
      if (list && !c.arg && $('#results')) {
        await loadList(list, c.params).catch(() => {});
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
    const list = listName(name, params);
    if (list) loadList(list, params).catch(() => {});
    else route();
  };
  let typing = null;
  view.addEventListener('input', (e) => {
    const form = e.target.closest('form.filters');
    if (!form) return;
    const { name, params } = current();
    params.set(e.target.name, e.target.value);
    params.delete('page'); // new filters start at the first page
    if (e.target.name === 'q') {
      clearTimeout(typing);
      typing = setTimeout(() => setParams(name, params, name === 'projects'), 300);
    } else setParams(name, params, name === 'projects');
  });
  view.addEventListener('change', (e) => {
    if (!e.target.matches('select[data-size]')) return;
    const { name, params } = current();
    params.set('size', e.target.value);
    savedSize = Number(e.target.value);
    params.delete('page');
    try { localStorage.setItem('teriac-page-size', e.target.value); } catch { /* ignore */ }
    setParams(name, params, name === 'projects');
  });
  view.addEventListener('submit', async (e) => {
    const grant = e.target.closest('form.grant');
    if (grant) {
      e.preventDefault();
      const f = new FormData(grant);
      const body = {
        user: f.get('user'), repo: f.get('repo'), projects: f.get('projects'), hours: Number(f.get('hours')), reason: f.get('reason'),
        actions: f.getAll('actions'), bypass: f.getAll('bypass'),
      };
      const btn = grant.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const g = await api('/api/grants', { method: 'POST', body: JSON.stringify(body) });
        toast(`Granted emergency access #${g.id} to ${g.user} until ${new Date(g.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
        return route();
      } catch (err) {
        toast(`Could not grant access: ${err.message}`, true);
        btn.disabled = false;
      }
      return;
    }
    if (e.target.closest('form.filters')) e.preventDefault();
  });

  view.addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-run]');
    if (row && !e.target.closest('a,button')) { location.hash = `runs/${row.dataset.run}`; return; }
    const linkRow = e.target.closest('tr[data-href]');
    if (linkRow && !e.target.closest('a,button')) { location.hash = linkRow.dataset.href; return; }
    const trig = e.target.closest('button[data-picker]');
    if (trig) {
      openPicker(trig, (from, to) => {
        const { name, params } = current();
        params.set('from', from);
        params.set('to', to);
        params.delete('page');
        if (trig.dataset.picker === 'metrics') { params.set('days', 'custom'); location.hash = `#metrics?${params}`; return; }
        params.set('range', 'custom');
        setParams(name, params, true);
      });
      return;
    }
    const range = e.target.closest('button[data-range]');
    if (range) {
      const { name, params } = current();
      params.set('range', range.dataset.range);
      params.delete('page');
      if (range.dataset.range !== 'custom') { params.delete('from'); params.delete('to'); }
      document.querySelectorAll('button[data-range]').forEach(b => b.setAttribute('aria-pressed', String(b === range)));
      document.querySelector('.f.custom').hidden = range.dataset.range !== 'custom';
      // Custom: choose the dates first.
      if (range.dataset.range === 'custom' && !(params.get('from') && params.get('to'))) {
        document.querySelector('.f.custom [data-picker]')?.click();
        return;
      }
      setParams(name, params);
      return;
    }
    const clear = e.target.closest('button[data-clear]');
    if (clear) {
      const { name, params } = current();
      const keep = clear.dataset.clear === '*'
        ? new URLSearchParams(Object.fromEntries(['sort', 'tab', 'size'].filter(k => params.get(k)).map(k => [k, params.get(k)])))
        : params;
      keep.delete('page');
      if (clear.dataset.clear !== '*') { keep.delete(clear.dataset.clear); if (clear.dataset.clear === 'range') { keep.delete('from'); keep.delete('to'); } }
      setParams(name, keep, true);
      return;
    }
    const pageBtn = e.target.closest('button[data-page]');
    if (pageBtn) {
      const { name, params } = current();
      params.set('page', pageBtn.dataset.page);
      setParams(name, params, name === 'projects');
      $('#results, #view')?.scrollIntoView({ block: 'start' });
      return;
    }
    const daysBtn = e.target.closest('button[data-days]');
    if (daysBtn) {
      const { params } = current();
      params.set('days', daysBtn.dataset.days);
      if (daysBtn.dataset.days !== 'custom') { params.delete('from'); params.delete('to'); }
      else if (!params.get('from')) {
        // Default to the last 30 days, then let the user change it.
        params.set('from', iso(new Date(Date.now() - 29 * 864e5)));
        params.set('to', iso(new Date()));
        location.hash = `#metrics?${params}`;
        setTimeout(() => document.querySelector('[data-picker="metrics"]')?.click(), 350);
        return;
      }
      location.hash = `#metrics?${params}`;
      return;
    }
    const unlock = e.target.closest('button[data-unlock]');
    if (unlock) {
      const l = JSON.parse(unlock.dataset.unlock);
      const ok = await confirmDialog({
        title: `Unlock ${l.project}?`,
        body: `<div class="facts">
            <span>Project</span><span class="mono">${esc(l.project)}${l.workspace !== 'default' ? ` @${esc(l.workspace)}` : ''}</span>
            <span>Held by</span><span>${l.prUrl ? ext(l.prUrl, `${esc(repoName(l.repo))} #${l.pr}`, 'plain') : `${esc(repoName(l.repo))} #${l.pr}`} · ${esc(l.user)}</span>
            <span>Since</span><span>${esc(ago(l.createdAt))}</span>
          </div>
          <ul>
            <li>The plan PR #${l.pr} made for this project is discarded; it must plan again before applying.</li>
            <li>Another pull request can then plan and apply this project.</li>
            <li>A comment on PR #${l.pr} says who unlocked it, and this is recorded in the audit log.</li>
          </ul>`,
        ok: 'Unlock', danger: true,
      });
      if (!ok) return;
      unlock.disabled = true;
      try {
        const r = await api('/api/locks/unlock', { method: 'POST', body: JSON.stringify({ repo: l.repo, project: l.project, workspace: l.workspace }) });
        toast(r.notified ? `Unlocked ${l.project}. PR #${l.pr} was told.` : `Unlocked ${l.project}. Could not comment on PR #${l.pr}; see the server log.`, !r.notified);
      } catch (err) {
        toast(`Could not unlock: ${err.message}`, true);
      }
      return route();
    }
    const revoke = e.target.closest('button[data-revoke]');
    if (revoke) {
      const ok = await confirmDialog({
        title: `Revoke emergency access #${esc(revoke.dataset.revoke)}?`,
        body: `<p>${esc(revoke.dataset.user)} loses this access now. This is recorded in the audit log and the channels are told.</p>`,
        ok: 'Revoke', danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/grants/${encodeURIComponent(revoke.dataset.revoke)}/revoke`, { method: 'POST' });
        toast(`Revoked emergency access #${revoke.dataset.revoke}.`);
      } catch (err) {
        toast(`Could not revoke: ${err.message}`, true);
      }
      return route();
    }
    const run = e.target.closest('button[data-drift]');
    if (run) {
      run.disabled = true;
      await api(`/api/drift/run?key=${encodeURIComponent(run.dataset.drift)}`, { method: 'POST' })
        .then(() => { run.textContent = 'Started'; toast('Drift check started. Results appear here when it finishes.'); })
        .catch(err => alertRow(run, err));
    }
  });
  const alertRow = (btn, err) => { btn.textContent = err.message; btn.disabled = false; };

  // ---- dialog and toast -------------------------------------------------------
  const modal = $('#modal');
  const confirmDialog = ({ title, body, ok, danger }) => new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = body;
    const okBtn = $('#modal-ok');
    okBtn.textContent = ok;
    okBtn.className = danger ? 'danger' : '';
    modal.returnValue = '';
    modal.addEventListener('close', () => resolve(modal.returnValue === 'ok'), { once: true });
    modal.showModal();
    modal.querySelector('button[value="cancel"]').focus(); // the safe choice first
  });
  let toastTimer = null;
  const toast = (text, bad = false) => {
    const el = $('#toast');
    el.textContent = text;
    el.className = `toast${bad ? ' bad' : ''}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
  };

  // ---- theme ------------------------------------------------------------------
  const THEMES = ['system', 'light', 'dark'];
  const ICON = { system: '◐', light: '☀', dark: '☾' };
  let theme = 'system';
  try { theme = localStorage.getItem('teriac-theme') || 'system'; } catch { /* ignore */ }
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
    try { localStorage.setItem('teriac-theme', theme); } catch { /* ignore */ }
    applyTheme();
  });
  applyTheme();

  // ---- sign-in ------------------------------------------------------------
  const signedIn = (who) => {
    me = who;
    document.body.classList.remove('signed-out');
    $('#signin').hidden = true;
    $('#signout').hidden = false;
    const el = $('#me');
    el.hidden = false;
    el.innerHTML = `${avatar(who.name)}<span class="who-name"><b>${esc(who.name)}</b><span class="muted small">${esc(who.role)} · ${esc(who.via || '')}</span></span>`;
    $('#version').textContent = who.version ? `v${who.version}` : '';
    const conn = $('#connected');
    const ps = who.platforms || [];
    conn.hidden = !ps.length;
    conn.innerHTML = ps.map(p => `<span class="inline" title="teriac is connected to ${esc(p.name)}">${platformIcon(p.name, 16)} ${esc(p.name)}</span>`).join('');
    if (location.hash.startsWith('#signin-error')) history.replaceState(null, '', '#overview');
    route();
  };

  async function showSignIn(message) {
    me = null;
    document.body.classList.add('signed-out');
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
    try { sessionStorage.removeItem('teriac-token'); } catch { /* ignore */ }
    fetch('/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'teriac' } }).catch(() => {});
    showSignIn(message);
  }

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'teriac' },
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
    try { sessionStorage.setItem('teriac-token', token); } catch { /* ignore */ }
    signedIn(await res.json());
  });

  $('#signout').addEventListener('click', () => signOut());
  // Moving to another page (sidebar, Back button) cancels an open confirmation or date picker,
  // so a confirm never acts on a page the user has left.
  window.addEventListener('hashchange', () => {
    if (modal.open) modal.close('');
    if (picker.el) closePicker();
    if (me) route();
  });

  // Start: an existing session or token signs in straight away.
  (async () => {
    const failure = /^#signin-error=(.*)$/.exec(location.hash);
    if (failure) return showSignIn(decodeURIComponent(failure[1]));
    const res = await fetch('/api/me', { credentials: 'same-origin', headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => null);
    if (res && res.ok) signedIn(await res.json()); else showSignIn();
  })();
})();
