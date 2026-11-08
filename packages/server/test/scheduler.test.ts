import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FairScheduler, App } from '../src/app.ts';

const tick = () => new Promise(r => setTimeout(r, 5));

// A job that waits until released; records what was running when it started.
const harness = (sched: FairScheduler) => {
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const run = (group: string, name: string) => sched.use(group, () => new Promise<void>(done => {
    started.push(name);
    releases.push(done);
  }));
  return { started, run, releaseOne: async () => { releases.shift()!(); await tick(); } };
};

test('never more than the total; one PR never takes every slot', async () => {
  const s = new FairScheduler(4, 3);
  const h = harness(s);
  // A big terragrunt PR queues 10 units.
  for (let i = 0; i < 10; i++) h.run('pr-1', `big-${i}`);
  await tick();
  assert.equal(h.started.length, 3, 'capped at its share');
  // Another PR arrives: it gets the free slot straight away.
  h.run('pr-2', 'small-0');
  await tick();
  assert.deepEqual(h.started.slice(3), ['small-0']);
  assert.deepEqual(s.stats, { active: 4, waiting: 7, groups: { 'pr-1': 3, 'pr-2': 1 } });
});

test('freed slots go to the PR with the fewest runs going', async () => {
  const s = new FairScheduler(2, 2);
  const h = harness(s);
  h.run('a', 'a1'); h.run('a', 'a2'); h.run('a', 'a3');
  h.run('b', 'b1');
  await tick();
  assert.deepEqual(h.started, ['a1', 'a2']);
  await h.releaseOne(); // a1 done: b (0 running) beats a (1 running)
  assert.deepEqual(h.started, ['a1', 'a2', 'b1']);
  await h.releaseOne(); // a2 done
  assert.deepEqual(h.started, ['a1', 'a2', 'b1', 'a3']);
});

test('a lone PR still uses its whole share (no idle slots)', async () => {
  const s = new FairScheduler(3, 3);
  const h = harness(s);
  for (let i = 0; i < 5; i++) h.run('only', `u${i}`);
  await tick();
  assert.equal(h.started.length, 3);
});

test('dependency waves: vpc first, then everything that only needs vpc, together', () => {
  const p = (name: string, deps: string[] = []) => ({ name, dir: name, deps, workspace: 'default', engine: 'terragrunt', tool: 'opentofu', autoplan: true }) as any;
  const app = Object.create(App.prototype);
  const waves = app.waves([p('app', ['vpc', 'ecs']), p('vpc'), p('ecs', ['vpc']), p('dns'), p('cdn', ['dns'])]);
  assert.deepEqual(waves.map((w: any[]) => w.map(x => x.name).sort()), [['dns', 'vpc'], ['cdn', 'ecs'], ['app']]);
});

test('plans still waiting for an older commit skip themselves', () => {
  const app = Object.create(App.prototype);
  app.latestHead = new Map([['github.com/acme/infra#7', 'new-sha']]);
  const ctx = (sha: string) => ({ repoKey: 'github.com/acme/infra', pr: { number: 7, headSha: sha } }) as any;
  assert.equal(app.outdated(ctx('old-sha')), true);
  assert.equal(app.outdated(ctx('new-sha')), false);
  app.latestHead = new Map();
  assert.equal(app.outdated(ctx('old-sha')), false, 'unknown: never skip');
});
