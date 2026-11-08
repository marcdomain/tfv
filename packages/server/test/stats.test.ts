import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

test('metrics for a custom date range: only runs inside it, "to" exclusive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tfv-stats-'));
  const store = new Store(join(dir, 'db.sqlite'));
  try {
    const at = (iso: string, kind: 'plan' | 'apply', usage?: object, applied?: object) => {
      const id = store.startRun({ repo: 'github.com/acme/infra', pr: 1, project: 'p', workspace: 'default', kind, headSha: 'abc', user: 'bob' });
      store.finishRun(id, { status: 'success', output: '', usage: usage ?? null, applied: applied ?? null });
      (store as any).db.prepare('UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?').run(iso, iso, id);
    };
    at('2026-10-01T10:00:00.000Z', 'plan');
    at('2026-10-05T10:00:00.000Z', 'plan', { cpuSeconds: 3, peakMemory: 100, peakProcesses: 2 });
    at('2026-10-06T10:00:00.000Z', 'apply', undefined, { added: 2, changed: 1, destroyed: 0 });
    at('2026-10-10T00:00:00.000Z', 'plan'); // exactly "to": excluded
    const s = store.stats('2026-10-05T00:00:00.000Z', '2026-10-10T00:00:00.000Z');
    assert.equal(s.totals.runs, 2);
    assert.equal(s.totals.applies, 1);
    assert.deepEqual(s.resources, { added: 2, changed: 1, destroyed: 0 });
    assert.equal(s.usage.runs, 1);
    assert.deepEqual(s.daily.map(d => d.day), ['2026-10-05', '2026-10-06']);
    // Open-ended: everything from "from" on.
    assert.equal(store.stats('2026-10-05T00:00:00.000Z').totals.runs, 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage: measured on Linux; a command too fast to sample is reported as quick', async () => {
  const { UsageSampler, combineUsage, usageSupported } = await import('../src/usage.ts');
  const { spawn } = await import('node:child_process');
  const run = (cmd: string) => new Promise<any>((resolve) => {
    const c = spawn('sh', ['-c', cmd]);
    const s = new UsageSampler(c.pid!);
    c.on('close', () => resolve(s.stop()));
  });
  if (!usageSupported()) {
    assert.equal(await run('true'), null, 'nothing to measure with off Linux');
    return;
  }
  const slow = await run('i=0; while [ $i -lt 300000 ]; do i=$((i+1)); done');
  assert.ok(slow.peakMemory > 0 && slow.peakProcesses >= 1 && !slow.quick);
  assert.equal(combineUsage({ cpuSeconds: 0, peakMemory: 0, peakProcesses: 1, quick: true }, slow)!.quick, undefined);
});
