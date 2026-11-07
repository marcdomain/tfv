import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizePlan, renderComment, renderCheck, cleanOutput, tail, countsText } from '../src/render.ts';
import type { Run } from '../src/store.ts';

const fixture = (f: string) => readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf-8');
const changes = summarizePlan(JSON.parse(fixture('plan-changes.json')));
const noChange = summarizePlan(JSON.parse(fixture('plan-nochange.json')));

const run = (over: Partial<Run>): Run => ({
  id: 1, repo: 'github.com/acme/infra', pr: 7, project: 'envs/prod', workspace: 'default', kind: 'plan',
  status: 'success', headSha: 'abc1234def', user: 'bob', startedAt: '', finishedAt: '', engine: 'terraform 1.9.8',
  summary: JSON.stringify(changes), output: fixture('plan-changes.txt'), planPath: '/x', hasChanges: true, destroys: 2, targets: [], prAuthor: 'bob', dir: 'envs/prod', ...over,
});

test('summarizes a real terraform plan', () => {
  assert.deepEqual(
    { add: changes.add, change: changes.change, destroy: changes.destroy, replace: changes.replace },
    { add: 3, change: 1, destroy: 1, replace: 1 },
  );
  // Most dangerous first.
  assert.deepEqual(changes.changes.map(c => [c.action, c.address]), [
    ['delete', 'terraform_data.legacy_queue'],
    ['replace', 'terraform_data.database'],
    ['update', 'terraform_data.app_config'],
    ['create', 'terraform_data.cdn'],
    ['create', 'terraform_data.worker[0]'],
    ['create', 'terraform_data.worker[1]'],
  ]);
  assert.equal(changes.changes[1].reason, 'triggers_replace forces replacement');
  assert.deepEqual(changes.outputs.map(o => o.name).sort(), ['cdn_domain', 'endpoint']);
  assert.equal(countsText(changes), '3 to add, 1 to change, 1 to replace, 1 to destroy');
  assert.equal(noChange.noChanges, true);
  assert.equal(countsText(noChange), 'No changes');
});

test('comment: caution banner, table, details, footer', () => {
  const body = renderComment({
    marker: '<!-- tfv:summary -->', headSha: 'abc1234def', command: 'tfv', limit: 65000,
    projects: [
      { name: 'envs/prod', plan: run({}), blockers: ['1 more approval from team:platform-admins'] },
      { name: 'envs/dev', plan: run({ project: 'envs/dev', summary: JSON.stringify(noChange), hasChanges: false, destroys: 0, output: fixture('plan-nochange.txt') }) },
      { name: 'envs/stg', plan: run({ project: 'envs/stg', status: 'failed', summary: null, output: fixture('plan-error.txt'), hasChanges: false }) },
      { name: 'envs/qa', note: '🔒 locked by #3 (carol)' },
    ],
  });
  assert.ok(body.startsWith('<!-- tfv:summary -->'));
  assert.match(body, /### 🔴 tfv · 4 projects · `abc1234`/);
  assert.match(body, /> \[!CAUTION\]\n> \*\*2 resources will be destroyed or replaced\*\*/);
  assert.match(body, /`terraform_data\.database` \(replace: triggers_replace forces replacement\)/);
  assert.match(body, /\| `envs\/prod` \| terraform 1\.9\.8 \| ⚠️ \*\*\+3 ~1 ±1 −1\*\* \| 🔒 1 more approval from team:platform-admins \|/);
  assert.match(body, /\| `envs\/dev` \| terraform 1\.9\.8 \| ✅ no changes \| — \|/);
  assert.match(body, /\| `envs\/stg` \| terraform 1\.9\.8 \| ❌ failed \|/);
  assert.match(body, /\| `envs\/qa` \| — \| ⚠️ 🔒 locked by #3 \(carol\) \| — \|/);
  assert.match(body, /<details open><summary><b>envs\/stg<\/b> — plan failed/);
  assert.match(body, /Reference to undeclared input variable/);
  assert.match(body, /```diff\n-   terraform_data\.legacy_queue\n-\/\+ terraform_data\.database   # triggers_replace forces replacement/);
});

test('comment stays under the platform limit with huge output', () => {
  const huge = 'x'.repeat(200) + '\n';
  const projects = Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, plan: run({ project: `p${i}`, output: huge.repeat(2000) }) }));
  const body = renderComment({ marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, projects });
  assert.ok(body.length <= 65000, `length ${body.length}`);
  assert.match(body, /earlier characters omitted|Output too long/);
});

test('apply column follows the apply run', () => {
  const plan = run({ id: 5 });
  const body = renderComment({
    marker: 'M', headSha: plan.headSha, command: 'tfv', limit: 65000,
    projects: [{ name: 'envs/prod', plan, apply: run({ id: 6, kind: 'apply', output: 'Apply complete! Resources: 3 added, 1 changed, 2 destroyed.' }) }],
  });
  assert.match(body, /\| ✅ applied \|/);
  assert.match(body, /--- apply ---\nApply complete!/);
});

test('fences survive backticks in output', () => {
  const body = renderComment({ marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, projects: [{ name: 'p', plan: run({ output: 'a ``` b' }) }] });
  assert.match(body, /````\n[\s\S]*a ``` b[\s\S]*\n````/);
});

test('check run: ready vs blocked', () => {
  assert.match(renderCheck('envs/prod', run({}), []).summary, /🟢 Ready to apply/);
  assert.match(renderCheck('envs/prod', run({}), ['PR is not mergeable']).summary, /🔒 Apply blocked: PR is not mergeable/);
  assert.equal(renderCheck('envs/prod', run({ status: 'failed' }), undefined).title, 'plan failed');
});

test('output helpers', () => {
  assert.equal(cleanOutput('a: Refreshing state... [id=1]\nreal line\n\n\n\nend'), 'real line\n\nend');
  assert.match(tail('line1\nline2\nline3', 8), /omitted\)\nline3$/);
});

test('each project body is indented under its project (blockquote), output nested inside', () => {
  const body = renderComment({ marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, projects: [{ name: 'infra/dev', plan: run({ project: 'infra/dev' }) }] });
  const section = body.slice(body.indexOf('<details><summary><b>infra/dev</b>'));
  assert.match(section, /^<details><summary><b>infra\/dev<\/b> — [^<]+<\/summary>\n<blockquote>\n\n/);
  const open = section.indexOf('<blockquote>');
  const output = section.indexOf('<details><summary>Output</summary>');
  const close = section.indexOf('</blockquote>');
  assert.ok(open < output && output < close, 'Output sits inside the indented block');
  assert.match(section, /<\/details>\n\n<\/blockquote>\n<\/details>/);
});

test('"apply all ready projects" only shows where the server allows it', () => {
  const ready = (name: string) => ({ name, plan: run({ project: name, destroys: 0 }), blockers: [] });
  const input = { marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, projects: [ready('a'), ready('b')] };
  assert.match(renderComment(input), /- or comment `tfv apply` to apply both ready projects/);
  assert.match(renderComment({ ...input, projects: [ready('a'), ready('b'), ready('c')] }), /to apply all 3 ready projects/);
  const strict = renderComment({ ...input, oneProjectPerApply: true });
  assert.doesNotMatch(strict, /comment `tfv apply` to apply/);
  assert.match(strict, /Apply one project at a time: `tfv apply -p <project>`/);
});
