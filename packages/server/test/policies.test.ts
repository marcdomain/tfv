import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateRules, runCommands, getPath, stricter, validatePolicies } from '../src/policies.ts';

const plan = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'plan-changes.json'), 'utf-8'));
const prod = { name: 'envs/prod', dir: 'envs/prod' };

test('deny_if, require, actions and projects', () => {
  const findings = evaluateRules(plan, [
    // app_config is updated to replicas = 3: deny more than 2? use "in" on the image tag.
    { name: 'no-1.5-images', resource: 'terraform_data', deny_if: { attribute: 'input.image', matches: '^app:1\\.5' }, severity: 'medium', message: 'image 1.5 is not approved' },
    // CDN must carry an input (it does), so no finding from this rule.
    { name: 'cdn-input', resource: 'terraform_data', require: { attribute: 'input', exists: true } },
    // Deletes and replaces in prod are not allowed at all.
    { name: 'no-prod-destroy', projects: ['envs/prod'], actions: ['delete', 'replace'], message: 'needs a security override' },
    // Only for dev: never matches here.
    { name: 'dev-only', projects: ['envs/dev'], actions: ['create'] },
  ], prod);
  assert.deepEqual(findings.map(f => [f.rule, f.address, f.severity]), [
    ['no-1.5-images', 'terraform_data.app_config', 'medium'],
    ['no-prod-destroy', 'terraform_data.database', 'high'],
    ['no-prod-destroy', 'terraform_data.legacy_queue', 'high'],
  ]);
});

test('values unknown until apply are not judged', () => {
  // `output` of new resources is (known after apply).
  const f = evaluateRules(plan, [{ name: 'out', resource: 'terraform_data', actions: ['create'], require: { attribute: 'output', equals: 'x' } }], prod);
  assert.equal(f.length, 0);
});

test('paths, stricter modes and validation', () => {
  assert.deepEqual(getPath({ a: [{ b: 1 }] }, 'a.0.b'), { found: true, value: 1 });
  assert.deepEqual(getPath({ a: 1 }, 'a.b'), { found: false, value: undefined });
  assert.equal(stricter('audit', 'enforce'), 'enforce');
  assert.equal(stricter('enforce', 'audit'), 'enforce');
  assert.equal(stricter(undefined, 'audit'), 'audit');
  assert.throws(() => validatePolicies({ mode: 'strict' }, 'policies'), /mode must be off, audit or enforce/);
  assert.throws(() => validatePolicies({ rules: [{ name: 'x', severity: 'huge' }] }, 'policies'), /severity must be one of/);
  assert.throws(() => validatePolicies({ commands: [{ name: 'checkov' }] }, 'policies'), /needs a name and a "run"/);
});

test('external scanners: a non-zero exit is a finding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tfv-pol-'));
  try {
    const scanner = join(dir, 'scan');
    writeFileSync(scanner, '#!/bin/sh\necho "checking $1"\ngrep -q legacy_queue "$1" && { echo "FAILED CKV_TFV_1: legacy queue still referenced"; exit 1; }\nexit 0\n');
    chmodSync(scanner, 0o755);
    const json = join(dir, 'plan.json');
    writeFileSync(json, JSON.stringify(plan));
    const f = await runCommands([{ name: 'my-scanner', run: [scanner, '{plan_json}'], severity: 'critical' }], json, dir, { PATH: process.env.PATH }, prod);
    assert.equal(f.length, 1);
    assert.equal(f[0].rule, 'my-scanner');
    assert.equal(f[0].severity, 'critical');
    assert.match(f[0].message, /FAILED CKV_TFV_1/);
    writeFileSync(json, '{}');
    assert.equal((await runCommands([{ name: 'my-scanner', run: [scanner, '{plan_json}'] }], json, dir, { PATH: process.env.PATH }, prod)).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
