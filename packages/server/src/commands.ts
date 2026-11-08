// Parses PR comment commands:
//   tfv plan [-p project] [-d dir] [-w workspace] [-t address]... [--destroy] [-- extra args]
//   tfv apply [-p project] [-d dir] [-w workspace]
//   tfv unlock [-p project]
//   tfv help
// "atlantis plan" etc. also work when Atlantis compatibility is on.

export type Verb = 'plan' | 'apply' | 'unlock' | 'help';
const VERBS: Verb[] = ['plan', 'apply', 'unlock', 'help'];

export interface Command {
  verb: Verb;
  project?: string;
  dir?: string;
  workspace?: string;
  destroy: boolean;
  targets: string[];          // resource addresses for -target
  extraArgs: string[];
}

// Resource addresses only: no leading "-", no spaces, so a target can never
// smuggle in another flag. Quotes are allowed for keys: aws_instance.web["a"].
export const TARGET_RE = /^[A-Za-z_][\w.\-\[\]"*/:]*$/;

export type ParseResult =
  | { ok: true; command: Command }
  | { ok: false; error: string }
  | null; // not addressed to tfv

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

  const command: Command = { verb, destroy: false, targets: [], extraArgs: [] };
  const value = (i: number, flag: string): string => {
    const v = tokens[i + 1];
    if (v === undefined || v.startsWith('-')) throw new Error(`\`${flag}\` needs a value`);
    return v;
  };

  try {
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '--') { command.extraArgs = tokens.slice(i + 1); break; }
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
        default: throw new Error(`Unknown flag \`${t}\``);
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  if (command.destroy && verb !== 'plan') return { ok: false, error: '`--destroy` only works with plan' };
  if (command.extraArgs.length && verb !== 'plan') return { ok: false, error: 'Extra arguments only work with plan' };
  if (command.targets.length && verb !== 'plan') {
    return { ok: false, error: 'Targets are set when planning: `tfv plan -p <project> -t <address>`, then `tfv apply -p <project>`' };
  }
  if (command.targets.length && !command.project && !command.dir) {
    return { ok: false, error: 'Targets need a project: `tfv plan -p <project> -t <address>`' };
  }
  return { ok: true, command };
};

// Lists only what this server allows: a bare `apply` is left out when
// projects must be applied one at a time.
export const helpText = (name = 'tfv', oneProjectPerApply = false): string => [
  '### tfv commands',
  '| Command | What it does |',
  '|---|---|',
  `| \`${name} plan\` | Plan every project changed in this PR |`,
  `| \`${name} plan -p <project>\` | Plan one project (\`-d <dir>\` and \`-w <workspace>\` also work) |`,
  `| \`${name} plan -p <project> -t <address>\` | Plan only some resources (repeat \`-t\` for more) |`,
  `| \`${name} plan --destroy\` | Plan destroying the selected projects |`,
  ...(oneProjectPerApply ? [] : [`| \`${name} apply\` | Apply every planned project whose requirements are met |`]),
  `| \`${name} apply -p <project>\` | Apply one project${oneProjectPerApply ? ' (this server applies one project at a time)' : ''} |`,
  `| \`${name} unlock\` | Release this PR's locks and discard its plans |`,
].join('\n');
