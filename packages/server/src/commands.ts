// Parses PR comment commands:
//   teriac plan [-p project] [-d dir] [-w workspace] [-t address]... [--destroy] [--refresh-only] [--replace address]... [-- extra args]
//   teriac apply [-p project] [-d dir] [-w workspace]
//   teriac unlock [-p project]
//   teriac help
// Terraform commands on one project (-p is required):
//   teriac state list [address]... | state show <address> | state rm <address>... | state mv <from> <to>
//   teriac output [name] | show | validate | providers | fmt
//   teriac import <address> <id> | taint <address> | untaint <address> | force-unlock <lock-id>
// Comments start with "teriac" (or "@teriac").

import type { CommandAction } from './config.ts';

export type Verb = 'plan' | 'apply' | 'unlock' | 'help'
  | 'state' | 'output' | 'show' | 'validate' | 'providers' | 'fmt' | 'import' | 'taint' | 'untaint' | 'force-unlock';
const VERBS: Verb[] = ['plan', 'apply', 'unlock', 'help', 'state', 'output', 'show', 'validate', 'providers', 'fmt', 'import', 'taint', 'untaint', 'force-unlock'];

// Terraform commands teriac runs for a single project. Nothing else is passed through:
// commands like `console` or flags like `-chdir` could reach beyond the project.
export type ToolCommand = 'state list' | 'state show' | 'state rm' | 'state mv' | 'output' | 'show' | 'validate'
  | 'providers' | 'fmt' | 'import' | 'taint' | 'untaint' | 'force-unlock';
const STATE_SUBS = ['list', 'show', 'rm', 'mv'];

// The permission key each command checks. Each command has its own key; one that
// isn't set uses its group (plan, state_read, state_write, state_remove) — see policy.ts.
export const TOOL_ACTION: Record<ToolCommand, CommandAction> = {
  'state list': 'state_list', validate: 'validate', providers: 'providers', fmt: 'fmt',
  'state show': 'state_show', show: 'show', output: 'output',
  import: 'import', taint: 'taint', untaint: 'untaint',
  'state rm': 'state_rm', 'state mv': 'state_mv', 'force-unlock': 'force_unlock',
};
// Commands that edit the state directly (lock, approvals, re-plan afterwards).
export const EDITS_STATE: ToolCommand[] = ['import', 'taint', 'untaint', 'state rm', 'state mv', 'force-unlock'];

export interface Command {
  verb: Verb;
  project?: string;
  dir?: string;
  workspace?: string;
  destroy: boolean;
  override: boolean;          // apply despite enforced policy findings / apply windows (if allowed)
  targets: string[];          // resource addresses for -target
  extraArgs: string[];
  refreshOnly?: boolean;      // plan -refresh-only
  replace?: string[];         // plan -replace=<address>
  tool?: ToolCommand;         // a Terraform command such as "state list"
  args?: string[];            // its positional arguments, checked below
}

// Resource addresses only: no leading "-", no spaces, so a target can never
// smuggle in another flag. Quotes are allowed for keys: aws_instance.web["a"].
export const TARGET_RE = /^[A-Za-z_][\w.\-\[\]"*/:]*$/;

export type ParseResult =
  | { ok: true; command: Command }
  | { ok: false; error: string }
  | null; // not addressed to teriac

// Splits on whitespace, honoring single and double quotes.
const tokenize = (line: string): string[] => {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
};

export const parseCommand = (body: string, names: string[]): ParseResult => {
  // Only the first non-empty line counts, so quoted replies don't trigger runs.
  const line = body.split(/\r?\n/).map(l => l.trim()).find(Boolean);
  if (!line) return null;

  const tokens = tokenize(line);
  const name = tokens[0]?.replace(/^@/, '').toLowerCase();
  if (!name || !names.includes(name)) return null;

  const verb = (tokens[1] || 'help').toLowerCase() as Verb;
  if (!VERBS.includes(verb)) {
    return { ok: false, error: `Unknown command \`${tokens[1]}\`. Try \`${name} help\`.` };
  }

  const command: Command = { verb, destroy: false, override: false, targets: [], extraArgs: [] };
  let first = 2;
  if (verb === 'state') {
    const sub = (tokens[2] ?? '').toLowerCase();
    if (!STATE_SUBS.includes(sub)) return { ok: false, error: `\`${name} state\` needs one of: ${STATE_SUBS.join(', ')}` };
    command.tool = `state ${sub}` as ToolCommand;
    first = 3;
  } else if (!['plan', 'apply', 'unlock', 'help'].includes(verb)) {
    command.tool = verb as ToolCommand;
  }
  const positional: string[] = [];
  const value = (i: number, flag: string): string => {
    const v = tokens[i + 1];
    if (v === undefined || v.startsWith('-')) throw new Error(`\`${flag}\` needs a value`);
    return v;
  };

  try {
    for (let i = first; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '--') { command.extraArgs = tokens.slice(i + 1); break; }
      if (!t.startsWith('-')) {
        if (!command.tool) throw new Error(`Unexpected \`${t}\``);
        positional.push(t);
        continue;
      }
      const [flag, inline] = t.includes('=') && t.startsWith('-') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t, undefined];
      const take = (): string => (inline !== undefined ? inline : value(i++, flag));
      switch (flag) {
        case '-p': case '--project': command.project = take(); break;
        case '-d': case '--dir': command.dir = take().replace(/^\.\/?/, '').replace(/\/+$/, '') || '.'; break;
        case '-w': case '--workspace': command.workspace = take(); break;
        case '-t': case '--target': {
          const target = take();
          if (!TARGET_RE.test(target)) throw new Error(`\`${target}\` is not a resource address`);
          command.targets.push(target);
          break;
        }
        case '--destroy': command.destroy = true; break;
        case '--refresh-only': command.refreshOnly = true; break;
        case '--replace': {
          const a = take();
          if (!TARGET_RE.test(a)) throw new Error(`\`${a}\` is not a resource address`);
          (command.replace ??= []).push(a);
          break;
        }
        case '--override': command.override = true; break;
        default: throw new Error(`Unknown flag \`${t}\``);
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  if (command.tool) {
    const error = checkTool(name, command, positional);
    if (error) return { ok: false, error };
    command.args = positional;
    return { ok: true, command };
  }
  if ((command.refreshOnly || command.replace?.length) && verb !== 'plan') return { ok: false, error: '`--refresh-only` and `--replace` only work with plan' };
  if (command.refreshOnly && command.destroy) return { ok: false, error: '`--refresh-only` and `--destroy` can\'t be combined' };
  if (command.destroy && verb !== 'plan') return { ok: false, error: '`--destroy` only works with plan' };
  if (command.override && verb !== 'apply') return { ok: false, error: '`--override` only works with apply' };
  if (command.override && !command.project && !command.dir) return { ok: false, error: '`--override` needs a project: `teriac apply -p <project> --override`' };
  if (command.extraArgs.length && verb !== 'plan') return { ok: false, error: 'Extra arguments only work with plan' };
  if (command.targets.length && verb !== 'plan') {
    return { ok: false, error: 'Targets are set when planning: `teriac plan -p <project> -t <address>`, then `teriac apply -p <project>`' };
  }
  if (command.targets.length && !command.project && !command.dir) {
    return { ok: false, error: 'Targets need a project: `teriac plan -p <project> -t <address>`' };
  }
  return { ok: true, command };
};

// Arguments of a Terraform command: resource addresses must look like addresses,
// and nothing may start with "-", so no flag can be slipped in.
const OUTPUT_NAME = /^[A-Za-z_][\w-]*$/;
const LOCK_ID = /^[\w-]+$/;
const IMPORT_ID = /^[^-\s][^\s]*$/;
const checkTool = (name: string, c: Command, args: string[]): string | null => {
  const usage: Record<ToolCommand, string> = {
    'state list': 'state list [address]...', 'state show': 'state show <address>', 'state rm': 'state rm <address>...',
    'state mv': 'state mv <from> <to>', output: 'output [name]', show: 'show', validate: 'validate', providers: 'providers',
    fmt: 'fmt', import: 'import <address> <id>', taint: 'taint <address>', untaint: 'untaint <address>', 'force-unlock': 'force-unlock <lock-id>',
  };
  const tool = c.tool!;
  const bad = () => `Usage: \`${name} ${usage[tool].replace(/^(\S+(?: (?:list|show|rm|mv))?)/, '$1 -p <project>')}\``;
  if (!c.project && !c.dir) return `\`${name} ${tool}\` runs on one project: add \`-p <project>\``;
  if (c.targets.length || c.destroy || c.override || c.extraArgs.length || c.refreshOnly || c.replace?.length) return `Only \`-p\`, \`-d\` and \`-w\` work with \`${name} ${tool}\``;
  const addr = (a: string) => TARGET_RE.test(a);
  switch (tool) {
    case 'state list': return args.every(addr) ? null : bad();
    case 'state show': case 'taint': case 'untaint': return args.length === 1 && addr(args[0]) ? null : bad();
    case 'state rm': return args.length >= 1 && args.every(addr) ? null : bad();
    case 'state mv': return args.length === 2 && args.every(addr) ? null : bad();
    case 'output': return args.length <= 1 && args.every(a => OUTPUT_NAME.test(a)) ? null : bad();
    case 'show': case 'validate': case 'providers': case 'fmt': return args.length === 0 ? null : bad();
    case 'import': return args.length === 2 && addr(args[0]) && IMPORT_ID.test(args[1]) ? null : bad();
    case 'force-unlock': return args.length === 1 && LOCK_ID.test(args[0]) ? null : bad();
  }
};

// The Terraform arguments for a checked command.
export const toolArgs = (c: Command): string[] => {
  const a = c.args ?? [];
  switch (c.tool!) {
    case 'state list': return ['state', 'list', ...a];
    case 'state show': return ['state', 'show', ...a];
    case 'state rm': return ['state', 'rm', ...a];
    case 'state mv': return ['state', 'mv', ...a];
    case 'output': return ['output', '-no-color', ...a];
    case 'show': return ['show', '-no-color'];
    case 'validate': return ['validate', '-no-color'];
    case 'providers': return ['providers'];
    case 'fmt': return ['fmt', '-check', '-diff', '-recursive', '-no-color'];
    case 'import': return ['import', '-input=false', '-no-color', ...a];
    case 'taint': return ['taint', ...a];
    case 'untaint': return ['untaint', ...a];
    case 'force-unlock': return ['force-unlock', '-force', ...a];
  }
};

// Lists only what this server allows: a bare `apply` is left out when
// projects must be applied one at a time.
export const helpText = (name = 'teriac', oneProjectPerApply = false): string => [
  '### teriac commands',
  '| Command | What it does |',
  '|---|---|',
  `| \`${name} plan\` | Plan every project changed in this PR |`,
  `| \`${name} plan -p <project>\` | Plan one project (\`-d <dir>\` and \`-w <workspace>\` also work) |`,
  `| \`${name} plan -p <project> -t <address>\` | Plan only some resources (repeat \`-t\` for more) |`,
  `| \`${name} plan --destroy\` | Plan destroying the selected projects |`,
  `| \`${name} plan -p <project> --replace <address>\` | Plan replacing a resource (repeat for more) |`,
  `| \`${name} plan -p <project> --refresh-only\` | Plan updating state to match what's really deployed |`,
  ...(oneProjectPerApply ? [] : [`| \`${name} apply\` | Apply every planned project whose requirements are met |`]),
  `| \`${name} apply -p <project>\` | Apply one project${oneProjectPerApply ? ' (this server applies one project at a time)' : ''} |`,
  `| \`${name} unlock\` | Release this PR's locks and discard its plans |`,
  `| \`${name} state list -p <project> [address]\` | Resources in the state |`,
  `| \`${name} state show -p <project> <address>\` | One resource's attributes (sensitive values hidden) |`,
  `| \`${name} output -p <project> [name]\` | Output values (sensitive values hidden) |`,
  `| \`${name} show -p <project>\` | The whole current state |`,
  `| \`${name} validate -p <project>\` | Check the configuration |`,
  `| \`${name} providers -p <project>\` | The providers the project uses |`,
  `| \`${name} fmt -p <project>\` | Check formatting |`,
  `| \`${name} import -p <project> <address> <id>\` | Bring an existing resource under Terraform (\`state_write\`) |`,
  `| \`${name} taint -p <project> <address>\` | Replace a resource on the next apply (\`state_write\`); \`untaint\` undoes it |`,
  `| \`${name} state rm -p <project> <address>...\` | Stop managing resources without deleting them (\`state_remove\`) |`,
  `| \`${name} state mv -p <project> <from> <to>\` | Rename or move a resource in the state (\`state_remove\`) |`,
  `| \`${name} force-unlock -p <project> <lock-id>\` | Release a stuck Terraform state lock (\`state_remove\`) |`,
  '',
  'Commands that edit the state directly need approvals like an apply, take the lock, are audited, and plan the project again straight after.',
].join('\n');
