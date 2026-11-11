// Drift-fix PRs: when a drift check finds a resource changed outside Terraform, update
// the code to match reality where that's a safe, mechanical edit, and list the rest.
// Only attributes written as plain values (a string, number or true/false) directly in
// the resource block are edited, and only when the code still says what the state said.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locate } from './blame.ts';
import type { Author } from './blame.ts';

export interface DriftEdit { address: string; file: string; attribute: string; from: unknown; to: unknown }
export interface DriftManual { address: string; reason: string; author?: Author | null }
export interface DriftFix { files: { path: string; content: string }[]; edits: DriftEdit[]; manual: DriftManual[] }

type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

// Reads a plain HCL value: "text" (no ${...}), a number, or true/false.
export const parseLiteral = (raw: string): { ok: true; value: Scalar } | { ok: false } => {
  const v = raw.trim();
  if (v === 'true' || v === 'false') return { ok: true, value: v === 'true' };
  if (/^-?\d+(\.\d+)?$/.test(v)) return { ok: true, value: Number(v) };
  if (/^"(?:[^"\\$]|\\.|\$(?!\{))*"$/.test(v)) {
    try { return { ok: true, value: JSON.parse(v) as string }; } catch { return { ok: false }; }
  }
  return { ok: false };
};

const literal = (v: Scalar) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

// Attribute lines directly inside the block (not in nested blocks), by name, and the
// names of nested blocks (e.g. root_block_device { ... }).
const topLevelLines = (lines: string[], start: number, end: number) => {
  const attrs = new Map<string, number>();
  const blocks = new Set<string>();
  let depth = 0;
  for (let i = start - 1; i < end; i++) {
    const code = lines[i].replace(/("(?:[^"\\]|\\.)*")|#.*|\/\/.*/g, (m, str) => (str ? '""' : ''));
    if (depth === 1) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/.exec(lines[i]);
      if (m && !attrs.has(m[1])) attrs.set(m[1], i);
      const b = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?:"[^"]*"\s*)*\{/.exec(lines[i]);
      if (b) blocks.add(b[1]);
    }
    for (const ch of code) { if (ch === '{') depth++; if (ch === '}') depth--; }
  }
  return { attrs, blocks };
};

export const planDriftFix = (
  root: string, projectDir: string, plan: Record<string, any>, authors: Map<string, Author | null> = new Map(),
): DriftFix => {
  const contents = new Map<string, string[]>();
  const read = (file: string) => {
    if (!contents.has(file)) contents.set(file, readFileSync(join(root, file), 'utf-8').split('\n'));
    return contents.get(file)!;
  };
  const edits: DriftEdit[] = [];
  const manual: DriftManual[] = [];

  for (const rd of plan.resource_drift ?? []) {
    const address: string = rd.address;
    const author = authors.get(address) ?? null;
    const actions: string[] = rd.change?.actions ?? [];
    if (actions.join(',') !== 'update') {
      manual.push({ address, reason: actions.includes('delete') ? 'deleted outside Terraform' : 'changed in a way teriac does not edit', author });
      continue;
    }
    if (address.startsWith('module.')) { manual.push({ address, reason: 'set inside a module: change its inputs by hand', author }); continue; }
    const before: Record<string, unknown> = rd.change?.before ?? {};
    const after: Record<string, unknown> = rd.change?.after ?? {};
    const changed = Object.keys({ ...before, ...after }).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const loc = locate(root, projectDir, address);
    if (!loc || loc.via !== 'resource') { manual.push({ address, reason: 'its resource block was not found', author }); continue; }
    const lines = read(loc.file);
    const { attrs, blocks } = topLevelLines(lines, loc.start, loc.end);
    for (const key of changed) {
      if (key === 'tags_all' || key === 'id' || key === 'arn') continue; // computed, never in code
      const from = before[key];
      const to = after[key];
      if (blocks.has(key)) { manual.push({ address, reason: `\`${key}\` is a list or block: update it by hand`, author }); continue; }
      const lineNo = attrs.get(key);
      if (lineNo === undefined) { manual.push({ address, reason: `\`${key}\` is not set in the code (default or computed)`, author }); continue; }
      if (!isScalar(to) || !isScalar(from)) { manual.push({ address, reason: `\`${key}\` is a list or block: update it by hand`, author }); continue; }
      const m = /^(\s*[A-Za-z_][A-Za-z0-9_-]*\s*=\s*)(.*?)(\s*(?:#.*|\/\/.*)?)$/.exec(lines[lineNo]);
      const parsed = m ? parseLiteral(m[2]) : { ok: false as const };
      if (!m || !parsed.ok) { manual.push({ address, reason: `\`${key}\` comes from an expression or variable: update it by hand`, author }); continue; }
      if (parsed.value !== from) { manual.push({ address, reason: `\`${key}\` in the code doesn't match the last applied value`, author }); continue; }
      lines[lineNo] = `${m[1]}${literal(to)}${m[3]}`;
      edits.push({ address, file: loc.file, attribute: key, from, to });
    }
  }
  const files = [...new Set(edits.map(e => e.file))].map(path => ({ path, content: contents.get(path)!.join('\n') }));
  return { files, edits, manual };
};

export const driftFixBody = (project: string, branch: string, fix: DriftFix, schedule: string): string => {
  const lines = [
    `Drift check \`${schedule}\` found changes made outside Terraform in \`${project}\` on \`${branch}\`.`,
    '',
    'This PR updates the code to match what is running now. **Merge it** to accept the change. **Close it** and apply the base branch to put things back as the code says.',
    '',
    '**Updated in code**',
    ...fix.edits.map(e => `- \`${e.address}\` · \`${e.attribute}\`: ${JSON.stringify(e.from)} → ${JSON.stringify(e.to)} (\`${e.file}\`)`),
  ];
  if (fix.manual.length) {
    lines.push('', '**Needs a person** (teriac does not edit these)');
    for (const m of fix.manual) lines.push(`- \`${m.address}\`: ${m.reason}${m.author ? `. Last changed by ${m.author.name} in ${m.author.sha.slice(0, 7)}` : ''}`);
  }
  lines.push('', '<sub>Opened by teriac (`fix_pr: true` on this drift schedule). Review the plan teriac posts on this PR before merging.</sub>');
  return lines.join('\n');
};
