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

// Drops refresh noise and plan-file hints. A successful
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
export const fence = (text: string, lang = '') => {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

// GitHub can't show terminal colours, but it colours ```diff blocks by each line's first
// character: + green, - red, ! orange. Move Terraform's markers to the first column
// (updates and replaces get "!"); every other line starts with a space so it stays plain.
export const colorize = (text: string): string => text.split('\n').map(line => {
  const m = /^(\s*)(-\/\+|\+\/-|[+~-])( |$)(.*)$/.exec(line);
  if (!m) return ` ${line}`;
  const [, indent, marker, gap, rest] = m;
  if (marker === '+' || marker === '-') return `${marker}${indent}${' '}${gap}${rest}`;
  return `!${indent}${marker}${gap}${rest}`;
}).join('\n');

// Destroys and replacements first: they're what reviewers must not miss.
const ORDER: Record<ChangeAction, number> = { delete: 0, replace: 1, update: 2, create: 3, import: 4, move: 5, forget: 6 };

export const changeList = (s: PlanSummary, max = 200): string => {
  const lines = [...s.changes].sort((a, b) => ORDER[a.action] - ORDER[b.action]).slice(0, max).map(c => `${SYMBOL[c.action].padEnd(3)} ${c.address}${c.reason ? `   # ${c.reason}` : ''}`);
  if (s.changes.length > max) lines.push(`… and ${s.changes.length - max} more`);
  return fence(colorize(lines.join('\n')), 'diff');
};

// ---- PR comment -----------------------------------------------------------

export interface ProjectView {
  name: string;
  plan?: Run;
  apply?: Run;
  blockers?: string[];        // what stops apply, if anything
  note?: string;              // e.g. "locked by #12"
  dir?: string;               // project folder, for links
  checkUrl?: string | null;   // the project's check page, where the Apply button is
  applyBy?: string;           // e.g. "someone other than bob" (two-person rule)
}

interface PolicyView { mode: 'off' | 'audit' | 'enforce'; findings: { rule: string; severity: string; address: string; message: string }[] }
const policyOf = (run?: Run): PolicyView | null => (run?.policy ? JSON.parse(run.policy) as PolicyView : null);
const SEV: Record<string, string> = { critical: '🔴', high: '🔴', medium: '🟠', low: '🟡' };

// Links and pictures for people and code (source-control specific).
export interface CommentLinks {
  commit(sha: string): string;
  tree(sha: string, dir: string): string;
  user(login: string): string | null;
  avatar?(login: string): string | null;
  run?(id: number): string;    // the run's page in the tfv dashboard
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
  links?: CommentLinks;
  approvers?: string[];           // current approvals of the head commit
}

// A command in its own code block: GitHub shows a copy button on it.
export const cmdBlock = (cmd: string): string[] => ['```', cmd, '```'];
// The same, indented to stay inside a list item.
const listCmd = (cmd: string): string[] => cmdBlock(cmd).map(l => `  ${l}`);

// A person as "avatar + linked name"; never an @mention, so edits don't notify.
const personMd = (login: string, links?: CommentLinks): string => {
  const pic = links?.avatar?.(login);
  const url = links?.user(login);
  const img = pic ? `<img src="${pic}" width="18" height="18" align="center" alt=""> ` : '';
  return `${img}${url ? `[${login}](${url})` : login}`;
};

const parse = (run?: Run): PlanSummary | null => (run?.summary ? JSON.parse(run.summary) as PlanSummary : null);

const planCell = (v: ProjectView): string => {
  const p = v.plan;
  if (!p) return v.note ? `⚠️ ${v.note}` : '—';
  if (p.status === 'running' || p.status === 'queued') return '⏳ planning…';
  if (p.status === 'failed') return p.mocks?.length ? `⏳ waiting for ${p.mocks.map(m => `\`${m}\``).join(', ')}` : '❌ failed';
  const s = parse(p);
  if (!s || s.noChanges) return '✅ no changes';
  const parts = [s.add && `+${s.add}`, s.change && `~${s.change}`, s.replace && `±${s.replace}`, s.destroy && `−${s.destroy}`].filter(Boolean);
  const targeted = p.targets?.length ? ' 🎯 targeted' : '';
  return `${s.destroy || s.replace ? '⚠️' : '📝'} **${parts.join(' ') || 'outputs'}**${targeted}`;
};

type ApplyState = 'applying' | 'applied' | 'apply-failed' | 'none' | 'blocked' | 'ready';

const applyState = (v: ProjectView): ApplyState => {
  const a = v.apply;
  if (a && a.headSha === v.plan?.headSha && a.id > (v.plan?.id ?? 0)) {
    if (a.status === 'running') return 'applying';
    return a.status === 'success' ? 'applied' : 'apply-failed';
  }
  const s = parse(v.plan);
  if (!v.plan || v.plan.status !== 'success' || !s || s.noChanges) return 'none';
  return v.blockers?.length ? 'blocked' : 'ready';
};

// GitHub can't put buttons in a comment; this links to the check page that has one.
const applyLink = (v: ProjectView) => (v.checkUrl ? ` · [**▶ Apply**](${v.checkUrl})` : '');

const applyCell = (v: ProjectView): string => {
  switch (applyState(v)) {
    case 'applying': return '⏳ applying…';
    case 'applied': return '✅ applied';
    case 'apply-failed': return '❌ apply failed';
    case 'none': return '—';
    case 'blocked': return `🔒 ${v.blockers!.join('; ')}`;
    case 'ready': return `🟢 ready${applyLink(v)}`;
  }
};

export const renderComment = (input: CommentInput): string => {
  const { projects, command, headSha } = input;
  const short = headSha.slice(0, 7);
  const failed = projects.filter(v => v.plan?.status === 'failed' || v.apply?.status === 'failed').length;
  const dangerous = projects.flatMap(v => {
    const s = parse(v.plan);
    return s ? s.changes.filter(c => c.action === 'delete' || c.action === 'replace').map(c => ({ project: v.name, c })) : [];
  });

  const links = input.links;
  const head: string[] = [input.marker];
  const icon = failed ? '🔴' : dangerous.length ? '🟠' : '🟢';
  const shaText = links ? `[\`${short}\`](${links.commit(headSha)})` : `\`${short}\``;
  head.push(`### ${icon} tfv · ${projects.length} project${projects.length === 1 ? '' : 's'} · ${shaText}`);

  // One line of counts, so the state is clear before any detail.
  const ready = projects.filter(v => applyState(v) === 'ready');
  const waiting = projects.filter(v => applyState(v) === 'blocked');
  const applied = projects.filter(v => applyState(v) === 'applied');
  const stats = [
    dangerous.length && `⚠️ ${dangerous.length} to destroy or replace`,
    ready.length && `🟢 ${ready.length} ready to apply`,
    waiting.length && `🔒 ${waiting.length} waiting`,
    applied.length && `✅ ${applied.length} applied`,
    failed && `❌ ${failed} failed`,
    (() => {
      const n = projects.reduce((a, v) => a + (policyOf(v.plan)?.findings.length ?? 0), 0);
      return n ? `🛡️ ${n} policy finding${n === 1 ? '' : 's'}` : '';
    })(),
  ].filter(Boolean);
  if (stats.length) head.push(`<sub>${stats.join(' · ')}</sub>`);
  if (dangerous.length) {
    head.push('', '> [!CAUTION]', `> **${dangerous.length} resource${dangerous.length === 1 ? '' : 's'} will be destroyed or replaced**`);
    // Counts only: the resources are listed once, in each project's section below.
    const perProject = new Map<string, { delete: number; replace: number }>();
    for (const { project, c } of dangerous) {
      const n = perProject.get(project) ?? { delete: 0, replace: 0 };
      if (c.action === 'replace') n.replace++; else n.delete++;
      perProject.set(project, n);
    }
    for (const [project, n] of perProject) {
      head.push(`> - \`${project}\`: ${[n.delete && `${n.delete} to destroy`, n.replace && `${n.replace} to replace`].filter(Boolean).join(' · ')}`);
    }
  }
  for (const w of input.warnings ?? []) head.push('', `> [!WARNING]\n> ${w}`);

  const showProviders = projects.some(v => v.plan?.providers?.length);
  head.push('', `| Project | Engine${showProviders ? ' | Providers' : ''} | Plan | Apply | By |`, `|---|---${showProviders ? '|---' : ''}|---|---|---|`);
  for (const v of projects) {
    const name = links && v.plan ? `[\`${v.name}\`](${links.tree(v.plan.headSha, v.dir || v.plan.dir || v.name)})` : `\`${v.name}\``;
    const latest = v.apply && v.plan && v.apply.headSha === v.plan.headSha && v.apply.id > v.plan.id ? v.apply : v.plan;
    head.push(`| ${name} | ${v.plan?.engine || '—'}${showProviders ? ` | ${providersCell(v.plan?.providers)}` : ''} | ${planCell(v)} | ${applyCell(v)} | ${latest ? personMd(latest.user, links) : '—'} |`);
  }

  if (input.approvers?.length) {
    head.push('', `**Approved by** ${input.approvers.map(a => personMd(a, links)).join(' · ')}`);
  }

  // What needs attention. Ready projects aren't repeated here: the table shows them,
  // with ▶ Apply, and each project's section has its apply command.
  const steps: string[] = [];
  // Only where this server lets one command apply several projects.
  if (ready.length > 1 && !input.oneProjectPerApply) {
    steps.push(`- Or apply ${ready.length === 2 ? 'both' : `all ${ready.length}`} ready projects at once:`, ...listCmd(`${command} apply`));
  }
  for (const v of waiting) steps.push(`- 🔒 **\`${v.name}\`** needs ${v.blockers!.join('; ')}`);
  for (const v of projects.filter(x => x.plan?.status === 'failed' && x.plan.mocks?.length)) {
    const deps = v.plan!.mocks;
    steps.push(`- ⏳ **\`${v.name}\`** needs ${deps.map(d => `\`${d}\``).join(', ')} applied first:`, ...deps.flatMap(d => listCmd(`${command} apply -p ${d}`)));
  }
  for (const v of projects.filter(x => x.plan?.status === 'failed' && !x.plan.mocks?.length)) {
    steps.push(`- ❌ **\`${v.name}\`** failed. Fix it and push, or plan it again:`, ...listCmd(`${command} plan -p ${v.name}`));
  }
  if (steps.length) head.push('', '**Next steps**', ...steps);

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
    // The body sits in a blockquote so it renders indented under the project.
    lines.push('', `<details${v.plan?.status === 'failed' ? ' open' : ''}><summary><b>${v.name}</b> — ${title}</summary>`, '<blockquote>', '');
    if (v.plan?.status === 'failed' && v.plan.mocks?.length) {
      const n = v.plan.mocks.length;
      lines.push(`> [!IMPORTANT]\n> **Waiting for ${v.plan.mocks.map(m => `\`${m}\``).join(', ')}**, which ${n === 1 ? "isn't" : "aren't"} applied yet and ${n === 1 ? 'has' : 'have'} no outputs, and this unit has no \`mock_outputs\` to plan with. Apply ${n === 1 ? 'it' : 'them'} first; tfv then plans this unit again with the real outputs.`, '');
    } else if (v.plan?.mocks?.length) {
      lines.push(`> [!WARNING]\n> **Planned with mock outputs** from ${v.plan.mocks.map(m => `\`${m}\``).join(', ')}, which ${v.plan.mocks.length === 1 ? "isn't" : "aren't"} applied yet. This plan can't be applied: apply ${v.plan.mocks.length === 1 ? 'it' : 'them'} first, and tfv re-plans this project with the real outputs.`, '');
    }
    const pol = policyOf(v.plan);
    if (pol && pol.mode !== 'off') {
      if (pol.findings.length) {
        lines.push(`🛡️ **Policy ${pol.mode === 'enforce' ? '(enforced: blocks apply)' : '(audit: not blocking)'}:** ${pol.findings.length} finding${pol.findings.length === 1 ? '' : 's'}`);
        for (const f of pol.findings.slice(0, 20)) {
          lines.push(`- ${SEV[f.severity] ?? '🔴'} **${f.rule}** · \`${f.address}\` · ${f.message.split('\n')[0].slice(0, 200)}`);
        }
        if (pol.findings.length > 20) lines.push(`- … and ${pol.findings.length - 20} more (see the dashboard)`);
        lines.push('');
      } else {
        lines.push('🛡️ **Policy:** passed', '');
      }
    }
    const by = v.applyBy ? ` (${v.applyBy})` : '';
    if (applyState(v) === 'ready') {
      lines.push(`**To apply${by}:** comment this${v.checkUrl ? `, or [**▶ Apply**](${v.checkUrl})` : ''}:`, ...cmdBlock(`${command} apply -p ${v.name}`), '');
    } else if (applyState(v) === 'blocked') {
      lines.push(`**To apply${by}:** first ${v.blockers!.join('; ')}. Then comment:`, ...cmdBlock(`${command} apply -p ${v.name}`), '');
    }
    if (v.plan && links?.run) lines.push(`[Open in the tfv dashboard](${links.run(v.plan.id)})`, '');
    if (v.plan?.targets?.length) {
      lines.push(`> [!NOTE]\n> **Targeted plan:** only ${v.plan.targets.map(t => `\`${t}\``).join(', ')}. Other changes in this project are not included. Plan without \`-t\` for the full picture.`, '');
    }
    if (s && s.changes.length) lines.push(changeList(s));
    if (s && s.drift.length) {
      lines.push('', `**Drift** (changed outside of Terraform): ${s.drift.slice(0, 20).map(d => `\`${d.address}\` ${d.action}`).join(', ')}`);
    }
    // Output changes, for when the full output (which lists them) doesn't fit.
    const outputsLine = s && s.outputs.length ? `**Outputs:** ${s.outputs.map(o => `\`${o.name}\` ${o.action}`).join(', ')}` : '';
    return { v, text: lines.join('\n'), outputsLine };
  });

  const outputs = projects.map(v => {
    const parts: string[] = [];
    const s = parse(v.plan);
    // A clean "no changes" needs no log.
    if (v.plan?.output && !(v.plan.status === 'success' && s?.noChanges)) parts.push(cleanOutput(v.plan.output, v.plan.status === 'success'));
    return parts.join('\n\n');
  });

  const fixed = [head.join('\n'), ...sections.map(s => `${s.text}\n\n</blockquote>\n</details>`), footer.join('\n')].join('\n').length;
  const wrapper = '\n\n**Output**\n\n```diff\n\n```\n</blockquote>\n'.length + 60;
  const withOutput = outputs.filter(Boolean).length;
  const budget = withOutput ? Math.floor((input.limit - fixed - withOutput * wrapper - 200) / withOutput) : 0;

  const body = [head.join('\n')];
  sections.forEach((s, i) => {
    body.push(s.text);
    if (outputs[i]) {
      if (budget >= 300) {
        // Shown in full once the project is opened: no second dropdown.
        body.push('', '**Output**', '', fence(colorize(tail(outputs[i], budget)), 'diff'));
      } else {
        if (s.outputsLine) body.push('', s.outputsLine);
        body.push('', `_Output too long for a comment; see the check run${input.dashboardUrl ? ' or dashboard' : ''}._`);
      }
    } else if (s.outputsLine) {
      body.push('', s.outputsLine);
    }
    body.push('', '</blockquote>', '</details>');
  });
  body.push(footer.join('\n'));
  const text = body.join('\n');
  return text.length <= input.limit ? text : `${text.slice(0, input.limit - 40)}\n\n_…comment truncated_`;
};

// ---- providers ------------------------------------------------------------------

// The providers a project uses: exact versions from .terraform.lock.hcl, otherwise
// the names from the plan's configuration. "registry.terraform.io/hashicorp/aws" → "hashicorp/aws".
export const providersOf = (lockFile: string | null, plan?: Record<string, any>): string[] => {
  const short = (src: string) => src.split('/').slice(-2).join('/');
  if (lockFile) {
    const out = [...lockFile.matchAll(/provider\s+"([^"]+)"\s*\{[^}]*?version\s*=\s*"([^"]+)"/g)].map(m => `${short(m[1])} ${m[2]}`);
    if (out.length) return out.sort();
  }
  const cfg = plan?.configuration?.provider_config ?? {};
  return [...new Set(Object.values<any>(cfg).map(p => p.full_name ? short(p.full_name) : p.name).filter(Boolean))].sort();
};

// "aws 5.70.0 · random 3.6.3": the namespace only when it isn't hashicorp.
const providersCell = (list: string[] | undefined): string =>
  list?.length ? list.map(p => p.replace(/^(hashicorp|opentofu)\//, '').replace(/^builtin\/(\S+)/, '$1 (built-in)')).join(' · ') : '—';

// ---- apply report ------------------------------------------------------------

export interface ApplyResult { added: number; changed: number; destroyed: number; imported: number }

// Terraform's own result line: "Apply complete! Resources: 2 added, 0 changed, 0 destroyed."
export const parseApplyResult = (output: string): ApplyResult | null => {
  const m = /Apply complete! Resources:\s*(?:(\d+) imported,\s*)?(\d+) added,\s*(\d+) changed,\s*(\d+) destroyed/.exec(output);
  return m ? { imported: Number(m[1] ?? 0), added: Number(m[2]), changed: Number(m[3]), destroyed: Number(m[4]) } : null;
};

// The "Outputs:" block Terraform prints after an apply.
export const parseApplyOutputs = (output: string): string | null => {
  const i = output.lastIndexOf('\nOutputs:\n');
  if (i < 0) return null;
  const block = output.slice(i + '\nOutputs:\n'.length).split('\n')
    .filter(l => !/^\$ /.test(l) && !/^\s*\d{2}:\d{2}:\d{2}\.\d+ /.test(l)) // stop words from tfv / terragrunt log lines
    .join('\n').trim();
  return block || null;
};

// Only the apply step's log (the plan was shown when it was planned).
const applyLog = (output: string): string => {
  const at = output.search(/^\$ \S+ apply\b/m);
  return cleanOutput(at >= 0 ? output.slice(at) : output, true);
};

export interface ApplyView { name: string; apply: Run; plan?: Run; dir?: string }

const PAST: Record<ChangeAction, string> = {
  create: 'Created', update: 'Updated', replace: 'Replaced', delete: 'Destroyed', import: 'Imported', forget: 'Removed from state', move: 'Moved',
};

export const renderApplyReport = (input: {
  marker: string; headSha: string; command: string; applies: ApplyView[]; links?: CommentLinks; limit: number; dashboardUrl?: string;
}): string => {
  const { applies, links, headSha } = input;
  const failed = applies.filter(v => v.apply.status === 'failed');
  const icon = failed.length ? '🔴' : '✅';
  const shaText = links ? `[\`${headSha.slice(0, 7)}\`](${links.commit(headSha)})` : `\`${headSha.slice(0, 7)}\``;
  const people = [...new Set(applies.map(v => v.apply.user))];
  const took = (r: Run) => (r.finishedAt && r.startedAt ? Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)) : null);

  const head: string[] = [input.marker];
  head.push(`### ${icon} tfv apply · ${applies.length} project${applies.length === 1 ? '' : 's'} · ${shaText}`);
  head.push(`<sub>${failed.length ? `❌ ${failed.length} failed · ` : ''}applied by ${people.map(u => personMd(u, links)).join(', ')}</sub>`);
  const provs = (v: ApplyView) => (v.apply.providers?.length ? v.apply.providers : v.plan?.providers) ?? [];
  const showProviders = applies.some(v => provs(v).length);
  head.push('', `| Project | Engine${showProviders ? ' | Providers' : ''} | Result | Resources | Took |`, `|---|---${showProviders ? '|---' : ''}|---|---|---|`);
  for (const v of applies) {
    const r = parseApplyResult(v.apply.output);
    const name = links ? `[\`${v.name}\`](${links.tree(v.apply.headSha, v.dir || v.apply.dir || v.name)})` : `\`${v.name}\``;
    const res = r ? [r.imported && `${r.imported} imported`, `${r.added} added`, `${r.changed} changed`, `${r.destroyed} destroyed`].filter(Boolean).join(' · ') : '—';
    const t = took(v.apply);
    head.push(`| ${name} | ${v.apply.engine || '—'}${showProviders ? ` | ${providersCell(provs(v))}` : ''} | ${v.apply.status === 'success' ? '✅ applied' : v.apply.status === 'running' ? '⏳ applying…' : '❌ failed'} | ${res} | ${t === null ? '—' : `${t}s`} |`);
  }

  const sections = applies.map(v => {
    const s = parse(v.plan);
    const ok = v.apply.status === 'success';
    const lines: string[] = ['', `<details${ok ? '' : ' open'}><summary><b>${v.name}</b> — ${ok ? 'applied' : 'apply failed'}</summary>`, '<blockquote>', ''];
    if (v.plan && links?.run) lines.push(`[Open in the tfv dashboard](${links.run(v.apply.id)})`, '');
    if (ok && s && s.changes.length) {
      const byAction = new Map<ChangeAction, string[]>();
      for (const c of s.changes) byAction.set(c.action, [...(byAction.get(c.action) ?? []), c.address]);
      for (const [action, addrs] of byAction) {
        lines.push(`**${PAST[action]}:** ${addrs.slice(0, 30).map(a => `\`${a}\``).join(', ')}${addrs.length > 30 ? ` and ${addrs.length - 30} more` : ''}`);
      }
      lines.push('');
    }
    const outputs = ok ? parseApplyOutputs(v.apply.output) : null;
    if (outputs) lines.push('**Outputs:**', fence(tail(outputs, 4000)), '');
    lines.push(`**${ok ? 'Apply log' : 'Error'}**`, '', fence(tail(applyLog(v.apply.output), Math.max(2000, Math.floor((input.limit - 4000) / Math.max(1, applies.length))))));
    lines.push('', '</blockquote>', '</details>');
    return lines.join('\n');
  });

  const footer = ['', '---', `<sub>\`${input.command} plan\` · \`${input.command} unlock\` · \`${input.command} help\`${input.dashboardUrl ? ` · [dashboard](${input.dashboardUrl})` : ''}</sub>`];
  const text = [head.join('\n'), ...sections, footer.join('\n')].join('\n');
  return text.length <= input.limit ? text : `${text.slice(0, input.limit - 40)}\n\n_…comment truncated_`;
};

// ---- check run ------------------------------------------------------------

export const CHECK_TEXT_LIMIT = 65000;

export const renderCheck = (projectName: string, run: Run, blockers: string[] | undefined) => {
  const s = parse(run);
  const ok = run.status === 'success';
  const title = !ok ? `${run.kind} failed` : run.kind === 'apply' ? 'Applied' : s ? countsText(s) : 'Planned';
  const summary: string[] = [`**${projectName}** · ${run.engine} · ${run.kind === 'apply' ? 'applied' : 'planned'} by ${run.user}${run.prAuthor && run.prAuthor !== run.user ? ` (PR by ${run.prAuthor})` : ''}${run.targets?.length ? ` · targeted: ${run.targets.map(t => `\`${t}\``).join(', ')}` : ''}`];
  if (s && s.changes.length) summary.push('', changeList(s, 100));
  if (run.kind === 'apply') {
    const r = parseApplyResult(run.output);
    if (r) summary.push('', `**Apply complete:** ${r.added} added · ${r.changed} changed · ${r.destroyed} destroyed`);
    const outs = parseApplyOutputs(run.output);
    if (outs) summary.push('', '**Outputs:**', fence(tail(outs, 4000)));
  }
  const pol = policyOf(run);
  if (pol && pol.mode !== 'off' && pol.findings.length) {
    summary.push('', `🛡️ **Policy (${pol.mode}):** ${pol.findings.length} finding${pol.findings.length === 1 ? '' : 's'}`,
      ...pol.findings.slice(0, 30).map(f => `- ${SEV[f.severity] ?? '🔴'} **${f.rule}** · \`${f.address}\` · ${f.message.split('\n')[0].slice(0, 200)}`));
  }
  if (ok && run.kind === 'plan' && s && !s.noChanges) {
    summary.push('', blockers?.length ? `🔒 Apply blocked: ${blockers.join('; ')}` : '🟢 Ready to apply');
  }
  const text = run.kind === 'apply'
    ? fence(tail(applyLog(run.output), CHECK_TEXT_LIMIT - 100))
    : fence(colorize(tail(cleanOutput(run.output, ok), CHECK_TEXT_LIMIT - 200)), 'diff');
  return { title, summary: summary.join('\n').slice(0, CHECK_TEXT_LIMIT), text, summaryData: s };
};
