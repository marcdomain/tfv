// Turns plan JSON (`terraform show -json`) into PR comments and check runs.
import type { Run } from './store.ts';

export type ChangeAction = 'create' | 'update' | 'delete' | 'replace' | 'import' | 'forget' | 'move';

export interface ResourceChange {
  address: string;
  action: ChangeAction;
  reason?: string;            // why a replace happens
}

export interface PlanSummary {
  add: number;
  change: number;
  destroy: number;
  replace: number;
  imports: number;
  changes: ResourceChange[];
  drift: ResourceChange[];
  outputs: { name: string; action: ChangeAction }[];
  noChanges: boolean;
}

const SYMBOL: Record<ChangeAction, string> = {
  create: '+', update: '~', delete: '-', replace: '-/+', import: '←', forget: '⊘', move: '→',
};

const actionOf = (actions: string[], importing: boolean, moved: boolean): ChangeAction | null => {
  const a = actions.join(',');
  if (a === 'create') return 'create';
  if (a === 'update') return 'update';
  if (a === 'delete') return 'delete';
  if (a === 'delete,create' || a === 'create,delete') return 'replace';
  if (a === 'forget') return 'forget';
  if (importing) return 'import';
  if (moved) return 'move';
  return null; // no-op / read
};

const pathText = (paths: unknown): string | undefined => {
  if (!Array.isArray(paths) || paths.length === 0) return undefined;
  const names = paths.map(p => (Array.isArray(p) ? p.join('.') : String(p)));
  return `${names.join(', ')} forces replacement`;
};

export const summarizePlan = (plan: Record<string, any>): PlanSummary => {
  const s: PlanSummary = { add: 0, change: 0, destroy: 0, replace: 0, imports: 0, changes: [], drift: [], outputs: [], noChanges: true };

  for (const rc of plan.resource_changes ?? []) {
    if (rc.mode === 'data') continue;
    const action = actionOf(rc.change?.actions ?? [], !!rc.change?.importing, !!rc.previous_address);
    if (!action) continue;
    if (action === 'create') s.add++;
    if (action === 'update') s.change++;
    if (action === 'delete') s.destroy++;
    if (action === 'replace') s.replace++;
    if (action === 'import' || rc.change?.importing) s.imports++;
    s.changes.push({ address: rc.address, action, reason: action === 'replace' ? pathText(rc.change?.replace_paths) : undefined });
  }
  for (const rd of plan.resource_drift ?? []) {
    const action = actionOf(rd.change?.actions ?? [], false, false);
    if (action) s.drift.push({ address: rd.address, action });
  }
  for (const [name, oc] of Object.entries<Record<string, any>>(plan.output_changes ?? {})) {
    const action = actionOf(oc.actions ?? [], false, false);
    if (action) s.outputs.push({ name, action });
  }
  // Most dangerous first, then by address.
  const rank: Record<ChangeAction, number> = { delete: 0, replace: 1, forget: 2, update: 3, create: 4, import: 5, move: 6 };
  s.changes.sort((a, b) => rank[a.action] - rank[b.action] || a.address.localeCompare(b.address));
  s.noChanges = s.changes.length === 0 && s.outputs.length === 0;
  return s;
};

export const countsText = (s: PlanSummary): string => {
  if (s.noChanges) return 'No changes';
  const parts: string[] = [];
  if (s.add) parts.push(`${s.add} to add`);
  if (s.change) parts.push(`${s.change} to change`);
  if (s.replace) parts.push(`${s.replace} to replace`);
  if (s.destroy) parts.push(`${s.destroy} to destroy`);
  if (s.imports) parts.push(`${s.imports} to import`);
  if (!parts.length) parts.push('Output changes only');
  return parts.join(', ');
};

const NOISE = [
  /: (Refreshing state\.\.\.|Reading\.\.\.|Read complete after)/,
  /^Saved the plan to: /,
  /^To perform exactly these actions, run the following command to apply:/,
  /^\s+(terraform|tofu|terragrunt) apply "?tfplan"?$/,
  /^─+$/,
];

// Drops refresh noise and plan-file hints, as Atlantis does. A successful
// run keeps only its main step; failures keep everything.
export const cleanOutput = (text: string, ok = false): string => {
  let lines = text.split('\n');
  if (ok) {
    const main = lines.findLastIndex(l => /^\$ \S+ (plan|apply)\b/.test(l));
    if (main > 0) lines = lines.slice(main);
  }
  return lines
    .filter(l => !NOISE.some(re => re.test(l)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

// Keeps the end of long output: errors and the plan summary are at the bottom.
export const tail = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  return `… (${text.length - max} earlier characters omitted)\n${cut.slice(cut.indexOf('\n') + 1)}`;
};

// Keeps fenced blocks intact even if output contains backticks.
const fence = (text: string, lang = '') => {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

export const changeList = (s: PlanSummary, max = 200): string => {
  const lines = s.changes.slice(0, max).map(c => `${SYMBOL[c.action].padEnd(3)} ${c.address}${c.reason ? `   # ${c.reason}` : ''}`);
  if (s.changes.length > max) lines.push(`… and ${s.changes.length - max} more`);
  return fence(lines.join('\n'), 'diff');
};

// ---- PR comment -----------------------------------------------------------

export interface ProjectView {
  name: string;
  plan?: Run;
  apply?: Run;
  blockers?: string[];        // what stops apply, if anything
  note?: string;              // e.g. "locked by #12"
}

export interface CommentInput {
  marker: string;
  headSha: string;
  command: string;            // "tfv"
  projects: ProjectView[];
  dashboardUrl?: string;
  limit: number;
  warnings?: string[];
  oneProjectPerApply?: boolean;   // footer advertises `apply -p` only
}

const parse = (run?: Run): PlanSummary | null => (run?.summary ? JSON.parse(run.summary) as PlanSummary : null);

const planCell = (v: ProjectView): string => {
  const p = v.plan;
  if (!p) return v.note ? `⚠️ ${v.note}` : '—';
  if (p.status === 'running' || p.status === 'queued') return '⏳ planning…';
  if (p.status === 'failed') return '❌ failed';
  const s = parse(p);
  if (!s || s.noChanges) return '✅ no changes';
  const parts = [s.add && `+${s.add}`, s.change && `~${s.change}`, s.replace && `±${s.replace}`, s.destroy && `−${s.destroy}`].filter(Boolean);
  const targeted = p.targets?.length ? ' 🎯 targeted' : '';
  return `${s.destroy || s.replace ? '⚠️' : '📝'} **${parts.join(' ') || 'outputs'}**${targeted}`;
};

const applyCell = (v: ProjectView): string => {
  const a = v.apply;
  if (a && a.headSha === v.plan?.headSha && a.id > (v.plan?.id ?? 0)) {
    if (a.status === 'running') return '⏳ applying…';
    return a.status === 'success' ? '✅ applied' : '❌ apply failed';
  }
  const s = parse(v.plan);
  if (!v.plan || v.plan.status !== 'success' || !s || s.noChanges) return '—';
  if (v.blockers?.length) return `🔒 ${v.blockers.join('; ')}`;
  return '🟢 ready';
};

export const renderComment = (input: CommentInput): string => {
  const { projects, command, headSha } = input;
  const short = headSha.slice(0, 7);
  const failed = projects.filter(v => v.plan?.status === 'failed' || v.apply?.status === 'failed').length;
  const dangerous = projects.flatMap(v => {
    const s = parse(v.plan);
    return s ? s.changes.filter(c => c.action === 'delete' || c.action === 'replace').map(c => ({ project: v.name, c })) : [];
  });

  const head: string[] = [input.marker];
  const icon = failed ? '🔴' : dangerous.length ? '🟠' : '🟢';
  head.push(`### ${icon} tfv · ${projects.length} project${projects.length === 1 ? '' : 's'} · \`${short}\``);
  if (dangerous.length) {
    head.push('', '> [!CAUTION]', `> **${dangerous.length} resource${dangerous.length === 1 ? '' : 's'} will be destroyed or replaced**`);
    for (const { project, c } of dangerous.slice(0, 15)) {
      head.push(`> - \`${project}\`: \`${c.address}\` (${c.action}${c.reason ? `: ${c.reason}` : ''})`);
    }
    if (dangerous.length > 15) head.push(`> - … and ${dangerous.length - 15} more`);
  }
  for (const w of input.warnings ?? []) head.push('', `> [!WARNING]\n> ${w}`);

  head.push('', '| Project | Engine | Plan | Apply |', '|---|---|---|---|');
  for (const v of projects) {
    head.push(`| \`${v.name}\` | ${v.plan?.engine || '—'} | ${planCell(v)} | ${applyCell(v)} |`);
  }

  const footer = [
    '',
    '---',
    `<sub>${input.oneProjectPerApply
      ? `Apply one project at a time: \`${command} apply -p <project>\``
      : `\`${command} apply\` applies every ready project · \`${command} apply -p <project>\``} · \`${command} plan -p <project> -t <address>\` · \`${command} unlock\` · \`${command} help\`${input.dashboardUrl ? ` · [dashboard](${input.dashboardUrl})` : ''}</sub>`,
  ];

  // Per-project details, then fit the raw output into what's left.
  const sections = projects.map(v => {
    const s = parse(v.plan);
    const lines: string[] = [];
    const title = v.plan?.status === 'failed' ? 'plan failed' : s ? countsText(s) : (v.note ?? 'not planned');
    lines.push('', `<details${v.plan?.status === 'failed' ? ' open' : ''}><summary><b>${v.name}</b> — ${title}</summary>`, '');
    if (v.plan?.targets?.length) {
      lines.push(`> [!NOTE]\n> **Targeted plan:** only ${v.plan.targets.map(t => `\`${t}\``).join(', ')}. Other changes in this project are not included. Plan without \`-t\` for the full picture.`, '');
    }
    if (s && s.changes.length) lines.push(changeList(s));
    if (s && s.drift.length) {
      lines.push('', `**Drift** (changed outside of Terraform): ${s.drift.slice(0, 20).map(d => `\`${d.address}\` ${d.action}`).join(', ')}`);
    }
    if (s && s.outputs.length) {
      lines.push('', `**Outputs:** ${s.outputs.map(o => `\`${o.name}\` ${o.action}`).join(', ')}`);
    }
    return { v, text: lines.join('\n') };
  });

  const outputs = projects.map(v => {
    const parts: string[] = [];
    const s = parse(v.plan);
    // A clean "no changes" needs no log.
    if (v.plan?.output && !(v.plan.status === 'success' && s?.noChanges)) parts.push(cleanOutput(v.plan.output, v.plan.status === 'success'));
    if (v.apply && v.apply.headSha === v.plan?.headSha && v.apply.output) parts.push(`--- apply ---\n${cleanOutput(v.apply.output, v.apply.status === 'success')}`);
    return parts.join('\n\n');
  });

  const fixed = [head.join('\n'), ...sections.map(s => `${s.text}\n</details>`), footer.join('\n')].join('\n').length;
  const wrapper = '\n\n<details><summary>Output</summary>\n\n```\n\n```\n</details>\n'.length + 60;
  const withOutput = outputs.filter(Boolean).length;
  const budget = withOutput ? Math.floor((input.limit - fixed - withOutput * wrapper - 200) / withOutput) : 0;

  const body = [head.join('\n')];
  sections.forEach((s, i) => {
    body.push(s.text);
    if (outputs[i]) {
      if (budget >= 300) {
        body.push('', '<details><summary>Output</summary>', '', fence(tail(outputs[i], budget)), '</details>');
      } else {
        body.push('', `_Output too long for a comment; see the check run${input.dashboardUrl ? ' or dashboard' : ''}._`);
      }
    }
    body.push('</details>');
  });
  body.push(footer.join('\n'));
  const text = body.join('\n');
  return text.length <= input.limit ? text : `${text.slice(0, input.limit - 40)}\n\n_…comment truncated_`;
};

// ---- check run ------------------------------------------------------------

export const CHECK_TEXT_LIMIT = 65000;

export const renderCheck = (projectName: string, run: Run, blockers: string[] | undefined) => {
  const s = parse(run);
  const ok = run.status === 'success';
  const title = !ok ? `${run.kind} failed` : run.kind === 'apply' ? 'Applied' : s ? countsText(s) : 'Planned';
  const summary: string[] = [`**${projectName}** · ${run.engine}${run.targets?.length ? ` · targeted: ${run.targets.map(t => `\`${t}\``).join(', ')}` : ''}`];
  if (s && s.changes.length) summary.push('', changeList(s, 100));
  if (ok && run.kind === 'plan' && s && !s.noChanges) {
    summary.push('', blockers?.length ? `🔒 Apply blocked: ${blockers.join('; ')}` : '🟢 Ready to apply');
  }
  const text = fence(tail(cleanOutput(run.output, ok), CHECK_TEXT_LIMIT - 100));
  return { title, summary: summary.join('\n').slice(0, CHECK_TEXT_LIMIT), text, summaryData: s };
};
