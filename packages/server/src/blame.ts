// Who last changed the code behind a resource address?
//   aws_s3_bucket.logs            → the `resource "aws_s3_bucket" "logs"` block
//   module.net.aws_subnet.a[0]    → the `module "net"` call in the project
// then `git log -1 -L start,end:file` on that block. Falls back to the last
// commit touching the project folder.
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { CloneAuth } from './vcs/types.ts';
import { git } from './git.ts';

export interface Author {
  name: string;
  email: string;
  sha: string;
  date: string;
  subject: string;
  via: 'resource' | 'module' | 'project';  // how precise the match is
  file?: string;
  start?: number;                           // lines of the block in `file` at HEAD
  end?: number;
}

// Splits an address into segments, ignoring [index] keys.
export const addressParts = (address: string): string[] =>
  address.replace(/\[[^\]]*\]/g, '').split('.').filter(Boolean);

// Finds the line range of a block in `text`. Braces inside strings and
// comments are rare enough in block headers to count naively.
export const findBlock = (text: string, header: RegExp): { start: number; end: number } | null => {
  const lines = text.split('\n');
  const startIdx = lines.findIndex(l => header.test(l));
  if (startIdx < 0) return null;
  let depth = 0;
  let seenOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    const code = lines[i].replace(/("(?:[^"\\]|\\.)*")|#.*|\/\/.*/g, (m, str) => (str ? '""' : ''));
    for (const ch of code) {
      if (ch === '{') { depth++; seenOpen = true; }
      if (ch === '}') depth--;
    }
    if (seenOpen && depth <= 0) return { start: startIdx + 1, end: i + 1 };
  }
  return { start: startIdx + 1, end: lines.length };
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The file and lines that declare `address` in the project folder.
export const locate = (root: string, projectDir: string, address: string): { file: string; start: number; end: number; via: 'resource' | 'module' } | null => {
  const parts = addressParts(address);
  let header: RegExp;
  let via: 'resource' | 'module';
  if (parts[0] === 'module' && parts[1]) {
    header = new RegExp(`^\\s*module\\s+"${escape(parts[1])}"`);
    via = 'module';
  } else {
    const [type, name] = parts[0] === 'data' ? [parts[1], parts[2]] : [parts[0], parts[1]];
    if (!type || !name) return null;
    header = new RegExp(`^\\s*${parts[0] === 'data' ? 'data' : 'resource'}\\s+"${escape(type)}"\\s+"${escape(name)}"`);
    via = 'resource';
  }
  const abs = projectDir === '.' ? root : join(root, projectDir);
  let files: string[];
  try {
    files = readdirSync(abs).filter(f => f.endsWith('.tf') || f.endsWith('.tofu')).sort();
  } catch {
    return null;
  }
  for (const f of files) {
    const block = findBlock(readFileSync(join(abs, f), 'utf-8'), header);
    if (block) return { file: projectDir === '.' ? f : posix.join(projectDir, f), ...block, via };
  }
  return null;
};

const SEP = '\x1f';
const FORMAT = ['%H', '%an', '%ae', '%aI', '%s'].join(SEP);

const parseLog = (out: string) => {
  const line = out.split('\n').find(l => l.includes(SEP));
  if (!line) return null;
  const [sha, name, email, date, subject] = line.split(SEP);
  return { sha, name, email, date, subject };
};

export const lastAuthor = async (root: string, projectDir: string, address: string, auth?: CloneAuth): Promise<Author | null> => {
  const where = locate(root, projectDir, address);
  if (where) {
    try {
      // -L prints the commit header first, then the diff; only the header is used.
      const out = await git(root, ['log', '-1', `--format=${FORMAT}`, `-L${where.start},${where.end}:${where.file}`, 'HEAD'], auth);
      const hit = parseLog(out);
      if (hit) return { ...hit, via: where.via, file: where.file, start: where.start, end: where.end };
    } catch {
      // fall through to the project-level answer
    }
  }
  const out = await git(root, ['log', '-1', `--format=${FORMAT}`, 'HEAD', '--', projectDir], auth).catch(() => '');
  const hit = parseLog(out);
  return hit ? { ...hit, via: 'project' } : null;
};
