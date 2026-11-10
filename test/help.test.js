const { helpTable, wantsTopHelp, loadCommands, GROUPS } = require('../lib/utils/help');

const width = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;
const tableLines = (out) => out.split('\n').filter((l) => /^[│┌├└]/.test(l));

test('every command is in the table', () => {
  const out = helpTable({ color: false });
  for (const cmd of loadCommands()) expect(out).toContain(`│ ${cmd.usage} `);
});

test('every command has a group (no "Other" section)', () => {
  const grouped = new Set(GROUPS.flatMap(([, names]) => names));
  expect(loadCommands().map((c) => c.name).filter((n) => !grouped.has(n))).toEqual([]);
});

test.each([60, 80, 100, 200])('rows line up at %i columns', (columns) => {
  for (const color of [true, false]) {
    const widths = new Set(tableLines(helpTable({ columns, color })).map(width));
    expect(widths.size).toBe(1);
  }
});

test('long descriptions wrap instead of overflowing', () => {
  const out = helpTable({ columns: 80, color: false });
  for (const line of tableLines(out)) expect(width(line)).toBeLessThanOrEqual(80);
});

test('a command not in any group is listed under Other', () => {
  const out = helpTable({ color: false, commands: [{ name: 'new-thing', usage: 'new-thing', aliases: '', desc: 'Brand new' }] });
  expect(out).toContain('│ Other');
  expect(out).toContain('│ new-thing');
});

test('only the top-level help is replaced', () => {
  expect(wantsTopHelp([])).toBe(true);
  expect(wantsTopHelp(['--help'])).toBe(true);
  expect(wantsTopHelp(['-h'])).toBe(true);
  expect(wantsTopHelp(['help'])).toBe(true);
  expect(wantsTopHelp(['install', '--help'])).toBe(false);
  expect(wantsTopHelp(['--version'])).toBe(false);
  expect(wantsTopHelp(['use', '1.10'])).toBe(false);
});

// Each shell's completion list must offer every command.
test.each([
  ['bash', /local cmds="([^"]+)"/],
  ['zsh', /cmds=\(([^)]+)\)/],
  ['fish', /set -l teriac_commands ([^\n]+)/],
  ['powershell', /\$commands = @\(([^)]+)\)/],
])('%s completions list every command', (shell, re) => {
  const { shellInit } = require('../lib/modules/shell-init');
  let out = '';
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true; });
  const log = jest.spyOn(console, 'log').mockImplementation((s) => { out += `${s}\n`; });
  try { shellInit(shell); } finally { spy.mockRestore(); log.mockRestore(); }
  const m = out.match(re);
  expect(m).not.toBeNull();
  const offered = new Set(m[1].replace(/[',]/g, ' ').split(/\s+/).filter(Boolean));
  for (const cmd of loadCommands()) expect([cmd.name, offered.has(cmd.name)]).toEqual([cmd.name, true]);
});
