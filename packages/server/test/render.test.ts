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
  summary: JSON.stringify(changes), output: fixture('plan-changes.txt'), planPath: '/x', hasChanges: true, destroys: 2, targets: [], prAuthor: 'bob', dir: 'envs/prod', policy: null, mocks: [], providers: [], usage: null, applied: null, ...over,
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
  assert.match(body, /> \[!CAUTION\]\n> \*\*2 resources will be destroyed or replaced\*\*\n> - `envs\/prod`: 1 to destroy · 1 to replace\n/);
  assert.doesNotMatch(body.split('| Project |')[0], /terraform_data\.legacy_queue/, 'resources are listed once, in the project section');
  assert.match(body, /\| `envs\/prod` \| terraform 1\.9\.8 \| ⚠️ \*\*\+3 ~1 ±1 −1\*\* \| 🔒 1 more approval from team:platform-admins \|/);
  assert.match(body, /\| `envs\/dev` \| terraform 1\.9\.8 \| ✅ no changes \| — \|/);
  assert.match(body, /\| `envs\/stg` \| terraform 1\.9\.8 \| ❌ failed \|/);
  assert.match(body, /\| `envs\/qa` \| — \| ⚠️ 🔒 locked by #3 \(carol\) \| — \|/);
  assert.match(body, /<details open><summary><b>envs\/stg<\/b> — plan failed/);
  assert.match(body, /Reference to undeclared input variable/);
  assert.match(body, /```diff\n-\s+terraform_data\.legacy_queue\n!-\/\+ terraform_data\.database   # triggers_replace forces replacement/);
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
  assert.doesNotMatch(body, /--- apply ---|Apply complete!/, 'the apply log belongs to the apply report, not the plan comment');
});

test('fences survive backticks in output', () => {
  const body = renderComment({ marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, projects: [{ name: 'p', plan: run({ output: 'a ``` b' }) }] });
  assert.match(body, /````diff\n[\s\S]*a ``` b[\s\S]*\n````/);
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

test('each project body is indented under its project (blockquote), output shown inside without another dropdown', () => {
  const body = renderComment({ marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, projects: [{ name: 'infra/dev', plan: run({ project: 'infra/dev' }) }] });
  const section = body.slice(body.indexOf('<details><summary><b>infra/dev</b>'));
  assert.match(section, /^<details><summary><b>infra\/dev<\/b> — [^<]+<\/summary>\n<blockquote>\n\n/);
  const open = section.indexOf('<blockquote>');
  const output = section.indexOf('**Output**\n\n```diff');
  assert.doesNotMatch(section, /<summary>Output<\/summary>/, 'no second dropdown');
  const close = section.indexOf('</blockquote>');
  assert.ok(open < output && output < close, 'Output sits inside the indented block');
  assert.match(section, /```\n\n<\/blockquote>\n<\/details>/, 'the output ends the section');
});

test('"apply all ready projects" only shows where the server allows it', () => {
  const ready = (name: string) => ({ name, plan: run({ project: name, destroys: 0 }), blockers: [] });
  const input = { marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, projects: [ready('a'), ready('b')] };
  assert.match(renderComment(input), /- Or apply both ready projects at once:\n  ```\n  tfv apply\n  ```/);
  assert.match(renderComment({ ...input, projects: [ready('a'), ready('b'), ready('c')] }), /Or apply all 3 ready projects at once:/);
  const strict = renderComment({ ...input, oneProjectPerApply: true });
  assert.doesNotMatch(strict, /ready projects at once/);
  assert.match(strict, /Apply one project at a time: `tfv apply -p <project>`/);
});

test('commands are in code blocks (GitHub adds a copy button)', () => {
  const body = renderComment({ marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, projects: [{ name: 'infra/dev', plan: run({ project: 'infra/dev', destroys: 0 }), blockers: [], checkUrl: 'https://github.com/x/runs/1' }] });
  assert.match(body, /\*\*To apply:\*\* comment this, or \[\*\*▶ Apply\*\*\]\([^)]+\):\n```\ntfv apply -p infra\/dev\n```/);
  assert.doesNotMatch(body, /is ready to apply/, 'the table and section already say so');
  assert.equal(body.split('tfv apply -p infra/dev').length - 1, 1, 'the command is shown once, in the project section');
});

test('apply report: real result, past tense, outputs, apply log only', async () => {
  const { renderApplyReport, parseApplyResult } = await import('../src/render.ts');
  const output = [
    '$ terraform plan -input=false -no-color -detailed-exitcode -out=tfplan',
    '  # terraform_data.app will be created',
    'Plan: 2 to add, 0 to change, 0 to destroy.',
    '--- apply ---',
    '$ terraform apply -input=false -no-color tfplan',
    'terraform_data.cache: Creating...',
    'terraform_data.app: Creation complete after 0s [id=14a8b452]',
    '',
    'Apply complete! Resources: 2 added, 0 changed, 0 destroyed.',
    '',
    'Outputs:',
    '',
    'app = {',
    '  "name" = "demo-app"',
    '}',
  ].join('\n');
  assert.deepEqual(parseApplyResult(output), { imported: 0, added: 2, changed: 0, destroyed: 0 });
  const apply = run({ project: 'infra/dev', kind: 'apply', output, startedAt: '2026-11-08T10:00:00Z', finishedAt: '2026-11-08T10:00:04Z' });
  const body = renderApplyReport({ marker: 'M', headSha: '0eb5c42aa', command: 'tfv', limit: 65000, applies: [{ name: 'infra/dev', apply, plan: run({ project: 'infra/dev' }) }] });
  assert.match(body, /### ✅ tfv apply · 1 project/);
  assert.match(body, /\| Project \| Engine \| Result \| Resources \| Took \|/);
  assert.match(body, /✅ applied \| 2 added · 0 changed · 0 destroyed \| 4s \|/);
  assert.match(body, /\*\*Outputs:\*\*\n```\napp = \{\n  "name" = "demo-app"\n\}\n```/);
  assert.match(body, /Apply log/);
  assert.doesNotMatch(body, /terraform plan|will be created|to add|\| Plan \|/, 'nothing from the plan');
});

test('plan output is coloured with a diff block', async () => {
  const { colorize } = await import('../src/render.ts');
  const out = colorize([
    '  # terraform_data.app will be destroyed',
    '  - resource "terraform_data" "app" {',
    '      - id     = "14a8" -> null',
    '      + input  = "x"',
    '      ~ input  = "a" -> "b"',
    '-/+ resource "terraform_data" "db" {',
    'Plan: 0 to add, 0 to change, 2 to destroy.',
  ].join('\n')).split('\n');
  assert.deepEqual(out, [
    '   # terraform_data.app will be destroyed',
    '-    resource "terraform_data" "app" {',
    '-        id     = "14a8" -> null',
    '+        input  = "x"',
    '!      ~ input  = "a" -> "b"',
    '!-/+ resource "terraform_data" "db" {',
    ' Plan: 0 to add, 0 to change, 2 to destroy.',
  ]);
});

test('providers: exact versions from the lock file, shown in the plan and apply tables', async () => {
  const { providersOf, renderApplyReport } = await import('../src/render.ts');
  const lock = [
    'provider "registry.terraform.io/hashicorp/aws" {',
    '  version     = "5.70.0"',
    '  constraints = "~> 5.0"',
    '  hashes = ["h1:abc="]',
    '}',
    'provider "registry.terraform.io/cloudflare/cloudflare" {',
    '  version = "4.40.0"',
    '}',
  ].join('\n');
  const list = providersOf(lock);
  assert.deepEqual(list, ['cloudflare/cloudflare 4.40.0', 'hashicorp/aws 5.70.0']);
  // No lock file: names from the plan.
  assert.deepEqual(providersOf(null, { configuration: { provider_config: { aws: { name: 'aws', full_name: 'registry.terraform.io/hashicorp/aws' } } } }), ['hashicorp/aws']);

  const plan = renderComment({ marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, projects: [{ name: 'infra/dev', plan: run({ project: 'infra/dev', providers: list }), blockers: [] }] });
  assert.match(plan, /\| Project \| Engine \| Providers \| Plan \| Apply \| By \|/);
  assert.match(plan, /\| terraform 1\.9\.8 \| cloudflare\/cloudflare 4\.40\.0 · aws 5\.70\.0 \|/);
  // None known: no column.
  assert.doesNotMatch(renderComment({ marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, projects: [{ name: 'x', plan: run({}), blockers: [] }] }), /Providers/);

  const apply = run({ project: 'infra/dev', kind: 'apply', output: 'Apply complete! Resources: 0 added, 0 changed, 2 destroyed.' });
  const report = renderApplyReport({ marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, applies: [{ name: 'infra/dev', apply, plan: run({ providers: ['hashicorp/terraform 1.9.8'] }) }] });
  assert.match(report, /\| Project \| Engine \| Providers \| Result \| Resources \| Took \|/);
  assert.match(report, /\| terraform 1\.9\.8 \| terraform 1\.9\.8 \| ✅ applied \| 0 added · 0 changed · 2 destroyed \|/);
});

test('output changes are listed only when the full output does not fit', () => {
  const p = { name: 'envs/prod', plan: run({}), blockers: [] };
  const fits = renderComment({ marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 65000, projects: [p] });
  assert.doesNotMatch(fits, /\*\*Outputs:\*\*/, 'the full output already shows them');
  assert.match(fits, /\*\*Output\*\*/);
  const cut = renderComment({ marker: 'M', headSha: 'abc1234', command: 'tfv', limit: 1300, projects: [p] });
  assert.match(cut, /\*\*Outputs:\*\* `/);
  assert.match(cut, /Output too long for a comment/);
});
