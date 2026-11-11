// The top-level help (`teriac --help`) as a table, grouped by what the commands do.
// Built from lib/commands, so a new command shows up without editing this file.
const { readdirSync } = require('fs');
const { join } = require('path');
const { P_OK, P_INFO, P_END } = require('./colors');

const GROUPS = [
  ['Versions', ['install', 'use', 'list', 'current', 'upgrade', 'remove', 'prune', 'exec']],
  ['Projects', ['auto-switch', 'pin', 'shell-init']],
  ['Terraform', ['init', 'plan', 'apply', 'destroy', 'fmt', 'validate']],
  ['Setup', ['doctor', 'plugin-cache']],
];

const loadCommands = (dir = join(__dirname, '..', 'commands')) => readdirSync(dir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => require(join(dir, f)))
  .filter((m) => typeof m.command === 'string')
  .map((m) => ({
    name: m.command.split(' ')[0],
    usage: m.command,
    aliases: (m.aliases || []).join(', '),
    desc: String(m.desc || '').trim().replace(/\.$/, ''),
  }));

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - visible(s)));

// Word-wraps text into lines of at most `width` characters.
const wrap = (text, width) => {
  const lines = [];
  let line = '';
  // Words longer than a line are split, after a "/" where possible.
  const words = text.split(/\s+/).flatMap((w) => {
    const parts = [];
    while (w.length > width) {
      const slash = w.lastIndexOf('/', width - 1);
      const cut = slash > 0 ? slash + 1 : width;
      parts.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    return [...parts, w];
  });
  for (const word of words) {
    if (line && (line + ' ' + word).length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
};

const helpTable = ({ commands = loadCommands(), columns = process.stdout.columns || 100, color = true } = {}) => {
  const c = (code, s) => (color ? `${code}${s}${P_END}` : s);
  const byName = new Map(commands.map((cmd) => [cmd.name, cmd]));
  const grouped = GROUPS.map(([title, names]) => [title, names.map((n) => byName.get(n)).filter(Boolean)]);
  const listed = new Set(grouped.flatMap(([, cmds]) => cmds.map((cmd) => cmd.name)));
  const rest = commands.filter((cmd) => !listed.has(cmd.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (rest.length) grouped.push(['Other', rest]);

  const w1 = Math.max('Command'.length, ...commands.map((cmd) => cmd.usage.length));
  const w2 = Math.max('Alias'.length, ...commands.map((cmd) => cmd.aliases.length));
  // Borders and padding take 10 characters; the description gets what's left (at least 24).
  const w3 = Math.max(24, Math.min(64, columns - w1 - w2 - 10));

  const rule = (l, m, r) => `${l}${'─'.repeat(w1 + 2)}${m}${'─'.repeat(w2 + 2)}${m}${'─'.repeat(w3 + 2)}${r}`;
  const row = (a, b, d) => `│ ${pad(a, w1)} │ ${pad(b, w2)} │ ${pad(d, w3)} │`;

  const out = ['', `${c(P_OK, 'teriac')} — one CLI for Terraform, OpenTofu & Terragrunt: versions, plans and applies, per-project setup`, '', `Usage: teriac <command> [options]`, ''];
  out.push(rule('┌', '┬', '┐'), row(c(P_OK, 'Command'), c(P_OK, 'Alias'), c(P_OK, 'Description')));
  for (const [title, cmds] of grouped) {
    if (!cmds.length) continue;
    out.push(rule('├', '┼', '┤'), row(c(P_INFO, title), '', ''));
    for (const cmd of cmds) {
      wrap(cmd.desc, w3).forEach((line, i) => out.push(i === 0 ? row(cmd.usage, cmd.aliases, line) : row('', '', line)));
    }
  }
  out.push(rule('└', '┴', '┘'), '');
  out.push('Options:', '  -h, --help     Show help', '      --version  Show version number', '');
  out.push(`Run ${c(P_INFO, 'teriac <command> --help')} for a command's options and examples.`, '');
  return out.join('\n');
};

// True for `teriac`, `teriac --help`, `teriac -h` and `teriac help`: the top-level help.
const wantsTopHelp = (args) => args.length === 0 || (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]));

module.exports = { helpTable, wantsTopHelp, loadCommands, GROUPS };
