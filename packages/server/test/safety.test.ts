// Unit tests for the safety features: each module on its own.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { scanSecrets, secretNote } from '../src/secrets.ts';
import { assessRisk, extraApprovalFor, isProduction } from '../src/risk.ts';
import { securityFindings, BUILTIN_RULE_NAMES } from '../src/security-rules.ts';
import { activeFreezes, protectedHits } from '../src/freeze.ts';
import { changeFingerprint, countApprovals, staleFor, staleText } from '../src/safety.ts';
import { parseServerPolicy, parseReposYaml } from '../src/config.ts';
import { parseRepoConfig } from '../src/repoConfig.ts';
import { stricterMode } from '../src/safety-config.ts';
import { validatePolicies } from '../src/policies.ts';
import { Store } from '../src/store.ts';
import { isGrantor, parseGrantRequest, GrantWatcher } from '../src/grants.ts';
import { buildSummary, SummaryScheduler } from '../src/summary.ts';
import { planDriftFix, parseLiteral, driftFixBody } from '../src/driftfix.ts';
import { notifyText } from '../src/notify.ts';
import { GitHubAdapter } from '../src/vcs/github.ts';
import type { PlanSummary } from '../src/render.ts';
import type { Comparison, Review } from '../src/vcs/types.ts';
import type { Project } from '../src/discovery.ts';

const summary = (changes: { address: string; action: string }[]): PlanSummary => ({
  add: 0, change: 0, destroy: 0, replace: 0, imports: 0, drift: [], outputs: [], noChanges: changes.length === 0,
  changes: changes as PlanSummary['changes'],
});
const proj = (name: string, extra: Partial<Project> = {}): Project => ({ name, dir: name, workspace: 'default', engine: 'terraform', deps: [], watch: [], autoplan: true, ...extra } as Project);

// ---------------------------------------------------------------------------
describe('leaked-secret scan', () => {
  test('hides known kinds and lists each once', () => {
    const r = scanSecrets([
      'key = "AKIAIOSFODNN7EXAMPLE"', 'other = "AKIAIOSFODNN7EXAMPLF"',
      'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
      'ghp_' + 'a'.repeat(36), 'xoxb-1234567890-abcdefghij', `AIza${'B'.repeat(35)}`, `sk_live_${'c'.repeat(24)}`,
    ].join('\n'));
    for (const kind of ['aws-access-key', 'aws-secret-key', 'private-key', 'github-token', 'slack-token', 'google-api-key', 'stripe-key']) {
      assert.ok(r.found.includes(kind), kind);
    }
    assert.equal(r.found.filter(k => k === 'aws-access-key').length, 1);
    assert.doesNotMatch(r.text, /AKIA|wJalrXUtnFEMI|BEGIN OPENSSH|ghp_a|xoxb-|AIzaB|sk_live_c/);
    assert.match(r.text, /aws_secret_access_key = ‹redacted: aws-secret-key›/);
  });
  test("keeps Terraform's own placeholders and ordinary output", () => {
    const text = '  + password = (sensitive value)\n  ~ password = "(known after apply)"\n  # aws_s3_bucket.logs will be created\nPlan: 1 to add.';
    const r = scanSecrets(text);
    assert.equal(r.text, text);
    assert.deepEqual(r.found, []);
  });
  test('password values in plan lines are hidden, the name kept', () => {
    const r = scanSecrets('      + master_password = "s3cr3t-value"');
    assert.equal(r.text, '      + master_password = "‹redacted: password›"');
  });
  test('custom patterns from repos.yaml', () => {
    const r = scanSecrets('token=acme_123456 x', [{ name: 'acme-token', regex: 'acme_[0-9]{6}' }]);
    assert.deepEqual([r.text, r.found], ['token=‹redacted: acme-token› x', ['acme-token']]);
  });
  test('the note names what was found', () => {
    assert.match(secretNote(['aws-access-key']), /looks like a secret was hidden.*aws-access-key/);
    assert.match(secretNote(['jwt', 'password']), /look like secrets were hidden.*jwt, password/);
  });
});

// ---------------------------------------------------------------------------
describe('risk score', () => {
  test('no changes: no score', () => {
    assert.equal(assessRisk(summary([]), proj('dev')), null);
    assert.equal(assessRisk(null, proj('dev')), null);
  });
  test('creating things outside production is low', () => {
    assert.deepEqual(assessRisk(summary([{ address: 'aws_s3_bucket.a', action: 'create' }]), proj('envs/dev')), { level: 'low', reasons: [] });
  });
  test('replacing a database: high outside production, critical in it', () => {
    const s = summary([{ address: 'module.db.aws_db_instance.main[0]', action: 'replace' }]);
    assert.equal(assessRisk(s, proj('envs/dev'))!.level, 'high');
    const prod = assessRisk(s, proj('envs/prod'))!;
    assert.equal(prod.level, 'critical');
    assert.match(prod.reasons[0], /stateful resource \(`module\.db\.aws_db_instance\.main\[0\]`\) in production/);
  });
  test('other destroys, access and network changes', () => {
    assert.equal(assessRisk(summary([{ address: 'aws_lambda_function.f', action: 'delete' }]), proj('dev'))!.level, 'medium');
    assert.equal(assessRisk(summary([{ address: 'aws_iam_role_policy.p', action: 'update' }]), proj('dev'))!.level, 'medium');
    assert.equal(assessRisk(summary([{ address: 'aws_iam_role_policy.p', action: 'update' }]), proj('prod'))!.level, 'high');
    assert.equal(assessRisk(summary([{ address: 'aws_security_group.web', action: 'update' }]), proj('dev'))!.level, 'medium');
  });
  test('size and policy findings', () => {
    const many = summary(Array.from({ length: 30 }, (_, i) => ({ address: `aws_sqs_queue.q${i}`, action: 'create' })));
    assert.equal(assessRisk(many, proj('dev'))!.level, 'medium');
    const huge = summary(Array.from({ length: 120 }, (_, i) => ({ address: `aws_sqs_queue.q${i}`, action: 'create' })));
    assert.equal(assessRisk(huge, proj('dev'))!.level, 'high');
    assert.equal(assessRisk(summary([{ address: 'aws_s3_bucket.a', action: 'create' }]), proj('dev'), [{ severity: 'critical' }])!.level, 'high');
  });
  test('any change to production is at least medium; production globs are configurable', () => {
    assert.equal(assessRisk(summary([{ address: 'aws_s3_bucket.a', action: 'create' }]), proj('live/prod/app'))!.level, 'medium');
    assert.equal(isProduction(proj('live/prod/app')), true);
    assert.equal(isProduction(proj('live/prod/app'), { production: ['customers/**'] }), false);
    assert.equal(isProduction(proj('customers/acme'), { production: ['customers/**'] }), true);
  });
  test('stateful_types: your own types count like a database', () => {
    const s = summary([{ address: 'mongodbatlas_cluster.main', action: 'replace' }]);
    assert.equal(assessRisk(s, proj('envs/dev'))!.level, 'medium', 'unknown type: an ordinary destroy');
    assert.equal(assessRisk(s, proj('envs/dev'), [], { stateful_types: ['mongodbatlas_*'] })!.level, 'high');
    assert.equal(assessRisk(s, proj('envs/prod'), [], { stateful_types: ['mongodbatlas_*'] })!.level, 'critical');
    assert.equal(assessRisk(summary([{ address: 'aws_db_instance.a', action: 'replace' }]), proj('envs/dev'), [], { stateful_types: ['x_*'] })!.level, 'high', 'built-in types still count');
  });
  test('size_limits: your own thresholds for medium and high', () => {
    const n = (k: number) => summary(Array.from({ length: k }, (_, i) => ({ address: `aws_sqs_queue.q${i}`, action: 'create' })));
    assert.equal(assessRisk(n(10), proj('dev'))!.level, 'low');
    assert.equal(assessRisk(n(10), proj('dev'), [], { size_limits: { medium: 5, high: 50 } })!.level, 'medium');
    assert.equal(assessRisk(n(60), proj('dev'), [], { size_limits: { medium: 5, high: 50 } })!.level, 'high');
    assert.equal(assessRisk(n(60), proj('dev'), [], { size_limits: { high: 500 } })!.level, 'medium', 'medium keeps its default');
  });
  test('extra approvals apply at their level and above', () => {
    const cfg = { extra_approval: { high: { from: 'team:sre', count: 1 }, critical: { from: 'team:sre', count: 2 } } };
    assert.equal(extraApprovalFor('medium', cfg), null);
    assert.deepEqual(extraApprovalFor('high', cfg), { from: 'team:sre', count: 1, level: 'high' });
    assert.deepEqual(extraApprovalFor('critical', cfg), { from: 'team:sre', count: 2, level: 'critical' });
    assert.equal(extraApprovalFor('critical', undefined), null);
  });
});

// ---------------------------------------------------------------------------
describe('built-in security rules', () => {
  const rc = (type: string, actions: string[], after: unknown, before: unknown = null, unknown: unknown = {}) =>
    ({ address: `${type}.x`, type, mode: 'managed', change: { actions, before, after, after_unknown: unknown } });
  const run = (...changes: unknown[]) => securityFindings({ resource_changes: changes }).map(f => f.rule);

  test('public buckets', () => {
    assert.deepEqual(run(rc('aws_s3_bucket_acl', ['create'], { acl: 'public-read' })), ['aws-s3-public-acl']);
    assert.deepEqual(run(rc('aws_s3_bucket_acl', ['create'], { acl: 'private' })), []);
    assert.deepEqual(run(rc('aws_s3_bucket_public_access_block', ['update'], { block_public_acls: true, block_public_policy: false, ignore_public_acls: true, restrict_public_buckets: true })), ['aws-s3-public-access-block-off']);
    const open = JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*' }] });
    const scoped = JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: '*', Condition: { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } } }] });
    assert.deepEqual(run(rc('aws_s3_bucket_policy', ['create'], { policy: open })), ['aws-s3-public-policy']);
    assert.deepEqual(run(rc('aws_s3_bucket_policy', ['create'], { policy: scoped })), []);
  });
  test('security groups open to the internet, except web ports', () => {
    const sg = (rules: unknown[]) => rc('aws_security_group', ['create'], { ingress: rules });
    assert.deepEqual(run(sg([{ from_port: 22, to_port: 22, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] }])), ['aws-security-group-open-ingress']);
    assert.deepEqual(run(sg([{ from_port: 443, to_port: 443, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] }])), []);
    assert.deepEqual(run(sg([{ from_port: 0, to_port: 0, protocol: '-1', ipv6_cidr_blocks: ['::/0'] }])), ['aws-security-group-open-ingress']);
    assert.deepEqual(run(sg([{ from_port: 22, to_port: 22, protocol: 'tcp', cidr_blocks: ['10.0.0.0/8'] }])), []);
    assert.deepEqual(run(rc('aws_security_group_rule', ['create'], { type: 'ingress', from_port: 3389, to_port: 3389, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'] })), ['aws-security-group-open-ingress']);
    assert.deepEqual(run(rc('aws_security_group_rule', ['create'], { type: 'egress', from_port: 0, to_port: 0, protocol: '-1', cidr_blocks: ['0.0.0.0/0'] })), []);
    assert.deepEqual(run(rc('aws_vpc_security_group_ingress_rule', ['create'], { cidr_ipv4: '0.0.0.0/0', from_port: 5432, to_port: 5432, ip_protocol: 'tcp' })), ['aws-security-group-open-ingress']);
  });
  test('unencrypted storage, public databases, IAM wildcards', () => {
    assert.deepEqual(run(rc('aws_db_instance', ['create'], { storage_encrypted: false, publicly_accessible: true })).sort(), ['aws-database-public', 'aws-storage-unencrypted']);
    assert.deepEqual(run(rc('aws_ebs_volume', ['create'], { encrypted: true })), []);
    const admin = JSON.stringify({ Statement: { Effect: 'Allow', Action: '*', Resource: '*' } });
    const scoped = JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['s3:*'], Resource: '*' }] });
    assert.deepEqual(run(rc('aws_iam_policy', ['create'], { policy: admin })), ['aws-iam-wildcard']);
    assert.deepEqual(run(rc('aws_iam_role_policy', ['update'], { policy: scoped })), []);
  });
  test('turning off protection, deleting keys, audit and backups', () => {
    assert.deepEqual(run(rc('aws_db_instance', ['update'], { deletion_protection: false, storage_encrypted: true }, { deletion_protection: true })), ['aws-deletion-protection-off']);
    assert.deepEqual(run(rc('aws_db_instance', ['create'], { deletion_protection: false, storage_encrypted: true })), []);
    assert.deepEqual(run(rc('aws_kms_key', ['delete'], null, { enable_key_rotation: true })), ['aws-kms-key-deleted']);
    assert.deepEqual(run(rc('aws_kms_key', ['create'], { enable_key_rotation: false })), ['aws-kms-rotation-off']);
    assert.deepEqual(run(rc('aws_kms_key', ['create'], { enable_key_rotation: false, customer_master_key_spec: 'RSA_2048' })), []);
    assert.deepEqual(run(rc('aws_cloudtrail', ['delete'], null, {})), ['aws-audit-or-backup-removed']);
    assert.deepEqual(run(rc('aws_backup_vault', ['delete'], null, {})), ['aws-audit-or-backup-removed']);
    assert.deepEqual(run(rc('aws_eks_cluster', ['create'], { vpc_config: [{ endpoint_public_access: true, public_access_cidrs: ['0.0.0.0/0'] }] })), ['aws-eks-public-endpoint']);
  });
  test('values only known at apply are not judged; rules can be turned off', () => {
    assert.deepEqual(run(rc('aws_iam_policy', ['create'], { policy: null }, null, { policy: true })), []);
    const p = { resource_changes: [rc('aws_s3_bucket_acl', ['create'], { acl: 'public-read' })] };
    assert.deepEqual(securityFindings(p, ['aws-s3-public-acl']), []);
  });
  test('config: builtin packs and disable are validated', () => {
    assert.ok(validatePolicies({ builtin: ['security'], disable: [BUILTIN_RULE_NAMES[0]] }, 'policies'));
    assert.throws(() => validatePolicies({ builtin: ['nope'] }, 'policies'), /unknown pack/);
    assert.throws(() => validatePolicies({ disable: ['nope'] }, 'policies'), /unknown built-in rule/);
  });
});

// ---------------------------------------------------------------------------
describe('change freezes and protected resources', () => {
  const cfg = [
    { name: 'weekend', projects: ['prod/**'], schedule: '0 15 * * 5', hours: 63, timezone: 'Europe/Madrid', override: ['team:sre'] },
    { name: 'holidays', from: '2026-12-23', to: '2027-01-02' },
  ];
  const at = (iso: string, p = proj('prod/app')) => activeFreezes(cfg, p, new Date(iso)).map(f => f.name);
  test('a scheduled window: on from its start for its length, in its time zone', () => {
    assert.deepEqual(at('2026-11-13T13:59:00Z'), []);            // Fri 14:59 Madrid
    assert.deepEqual(at('2026-11-13T14:00:00Z'), ['weekend']);   // Fri 15:00
    assert.deepEqual(at('2026-11-16T04:59:00Z'), ['weekend']);   // Mon 05:59
    assert.deepEqual(at('2026-11-16T05:00:00Z'), []);            // Mon 06:00
    assert.deepEqual(at('2026-11-14T12:00:00Z', proj('dev/app')), []); // not a matching project
    const [w] = activeFreezes(cfg, proj('prod/app'), new Date('2026-11-14T12:00:00Z'));
    assert.match(w.until, /Mon 16 Nov, 06:00 Europe\/Madrid/);
    assert.deepEqual(w.override, ['team:sre'], 'each window carries its own override list');
    assert.deepEqual(activeFreezes(cfg, proj('dev'), new Date('2026-12-24T10:00:00Z'))[0].override, [], 'no override list: nobody may skip it');
  });
  test('a date range covers whole days, both ends included', () => {
    assert.deepEqual(at('2026-12-22T23:59:00Z', proj('dev')), []);
    assert.deepEqual(at('2026-12-23T00:00:00Z', proj('dev')), ['holidays']);
    assert.deepEqual(at('2027-01-02T23:59:00Z', proj('dev')), ['holidays']);
    assert.deepEqual(at('2027-01-03T00:00:00Z', proj('dev')), []);
  });
  test('protected: destroys and replacements only, inside modules and with indexes too', () => {
    const p = [{ resources: ['aws_db_instance.*'], override: ['team:sre'] }, { projects: ['dev/**'], resources: ['aws_s3_bucket.*'] }];
    const s = summary([
      { address: 'module.db.aws_db_instance.main[0]', action: 'replace' },
      { address: 'aws_db_instance.other', action: 'update' },
      { address: 'aws_s3_bucket.logs', action: 'delete' },
    ]);
    assert.deepEqual(protectedHits(p, proj('prod/app'), s), [{ address: 'module.db.aws_db_instance.main[0]', override: ['team:sre'] }]);
    assert.deepEqual(protectedHits(p, proj('dev/app'), s), [
      { address: 'module.db.aws_db_instance.main[0]', override: ['team:sre'] },
      { address: 'aws_s3_bucket.logs', override: [] },
    ]);
    assert.deepEqual(protectedHits(undefined, proj('dev/app'), s), []);
  });
});

// ---------------------------------------------------------------------------
describe('approvals across rebases', () => {
  const files = (blob: string): Comparison => ({ files: [{ path: 'envs/prod/main.tf', status: 'modified', blob }], commits: [], truncated: false });
  test('fingerprint: same changes match, any content change differs, too many files is unknown', () => {
    assert.equal(changeFingerprint(files('a')), changeFingerprint(files('a')));
    assert.notEqual(changeFingerprint(files('a')), changeFingerprint(files('b')));
    const two = (order: string[]): Comparison => ({ files: order.map(p => ({ path: p, status: 'added', blob: p })), commits: [], truncated: false });
    assert.equal(changeFingerprint(two(['a', 'b'])), changeFingerprint(two(['b', 'a'])));
    assert.equal(changeFingerprint({ ...files('a'), truncated: true }), null);
    assert.equal(changeFingerprint(null), null);
  });

  const review = (user: string, sha: string, state: Review['state'] = 'approved'): Review => ({ user, state, commitSha: sha });
  const fps: Record<string, string | null> = { head: 'F1', rebased: 'F1', edited: 'F2', unknown: null };
  const fp = async (sha: string) => fps[sha] ?? null;
  const on = { reapproveOnChange: true, keepOnRebase: true };

  test('default: only approvals of the latest commit count', async () => {
    const r = await countApprovals([review('ada', 'head'), review('carol', 'rebased')], 'bob', 'head', { reapproveOnChange: true, keepOnRebase: false }, fp);
    assert.deepEqual(r, { approvers: ['ada'], carried: [] });
  });
  test('keep_approval_on_rebase: an approval before a rebase still counts; after an edit it does not', async () => {
    const r = await countApprovals([review('ada', 'rebased'), review('carol', 'edited')], 'bob', 'head', on, fp);
    assert.deepEqual(r, { approvers: ['ada'], carried: ['ada'] });
  });
  test("when the change can't be compared, a fresh approval is needed", async () => {
    const r = await countApprovals([review('ada', 'unknown')], 'bob', 'head', on, fp);
    assert.deepEqual(r.approvers, []);
    const noHead = await countApprovals([review('ada', 'rebased')], 'bob', 'head', on, async () => null);
    assert.deepEqual(noHead.approvers, []);
  });
  test('reapprove_on_change: false lets any approval count', async () => {
    const r = await countApprovals([review('ada', 'edited')], 'bob', 'head', { reapproveOnChange: false, keepOnRebase: false }, fp);
    assert.deepEqual(r.approvers, ['ada']);
  });
  test('the author never counts, and the latest review of each person wins', async () => {
    const r = await countApprovals([review('bob', 'head'), review('ada', 'head'), review('ada', 'head', 'changes_requested'), review('carol', 'head'), review('carol', 'head', 'commented')], 'bob', 'head', on, fp);
    assert.deepEqual(r.approvers, ['carol']);
  });
});

describe('out-of-date branches', () => {
  const projects = [proj('envs/prod'), proj('envs/dev'), proj('apps/api', { deps: ['modules/net'] })];
  const changes = (paths: string[], truncated = false): Comparison => ({
    files: paths.map(p => ({ path: p, status: 'modified', blob: 'x' })),
    commits: [{ sha: 'aaaaaaa1', message: 'bump instance size', author: 'ada', pr: 52 }, { sha: 'bbbbbbb2', message: 'tidy', author: 'erin' }],
    truncated,
  });
  test('only base changes to files this project uses count', () => {
    assert.equal(staleFor(projects[0], projects, changes(['envs/prod/main.tf']))?.length, 2);
    assert.equal(staleFor(projects[1], projects, changes(['envs/prod/main.tf'])), null);
    assert.ok(staleFor(projects[2], projects, changes(['modules/net/vpc.tf'])), 'a local module the project uses');
    assert.equal(staleFor(projects[0], projects, { files: [], commits: [], truncated: false }), null);
    assert.equal(staleFor(projects[0], projects, null), null);
    assert.ok(staleFor(projects[1], projects, changes(['x'], true)), 'a cut-short list warns rather than stays quiet');
  });
  test('the message names the commits and what to do', () => {
    const t = staleText(changes([]).commits, 'main', 'envs/prod', true);
    assert.match(t, /^`main` has 2 newer commits that change files `envs\/prod` uses \(bbbbbbb by erin: tidy; #52 by ada: bump instance size\)\. Applying this branch could undo them: rebase or merge `main` first$/);
    assert.match(staleText(changes([]).commits.slice(0, 1), 'main', 'p', false), /could undo it: consider rebasing/);
  });
});

// ---------------------------------------------------------------------------
describe('settings', () => {
  const channels = 'channels:\n  ops: { type: webhook, webhook_url_env: HOOK }\n';
  test('a full example parses', () => {
    const p = parseServerPolicy(`${channels}
secret_scan: { mode: fail, patterns: [{ name: acme, regex: "acme_[0-9]+" }] }
risk: { production: ["prod/**"], extra_approval: { high: { from: team:sre, count: 1 } } }
freezes:
  - { name: weekend, projects: ["prod/**"], schedule: "0 15 * * 5", hours: 63, timezone: Europe/Madrid, override: [team:sre] }
  - { name: holidays, from: "2026-12-23", to: "2027-01-02" }
protected:
  - { projects: ["prod/**"], resources: ["aws_db_instance.*"], override: [team:sre] }
break_glass: { grantors: [admin, "user:sre-lead@acme.com", "group:oncall"], max_hours: 4, notify: [ops] }
summary: { schedule: "0 9 * * 1", timezone: Europe/Madrid, notify: [ops] }
repos:
  - id: github.com/acme/*
    reapprove_on_change: true
    keep_approval_on_rebase: true
    stale_base: block
    verify_plan: true
    secret_scan: fail
`);
    assert.equal(p.secretScan?.mode, 'fail');
    assert.equal(p.freezes?.length, 2);
    assert.deepEqual(p.freezes?.[0].override, ['team:sre']);
    assert.deepEqual(p.protected?.[0].override, ['team:sre']);
    assert.equal(p.breakGlass?.max_hours, 4);
    assert.equal(p.summary?.schedule, '0 9 * * 1');
    assert.equal(p.repos[0].stale_base, 'block');
    assert.equal(p.repos[0].secret_scan, 'fail');
  });
  test('mistakes give clear errors', () => {
    const bad: [string, RegExp][] = [
      ['secret_scan: { mode: loud }', /secret_scan\.mode must be off, redact, fail/],
      ['secret_scan: { patterns: [{ name: x, regex: "(" }] }', /patterns\[0\]\.regex/],
      ['risk: { extra_approval: { huge: { from: x, count: 1 } } }', /unknown level "huge"/],
      ['risk: { extra_approval: { high: { from: x } } }', /needs "from" and "count"/],
      ['freezes: [{ name: a, schedule: "0 15 * * 5" }]', /hours must be/],
      ['freezes: [{ name: a, from: "2026-12-30", to: "2026-12-01" }]', /from must not be after to/],
      ['freezes: [{ name: a }]', /needs schedule \+ hours, or from \+ to/],
      ['freezes: [{ name: a, from: "2026-01-01", to: "2026-01-02", timezone: Mars/Base }]', /not a known time zone/],
      ['freezes: [{ name: a, from: "2026-01-01", to: "2026-01-02", override: team:sre }]', /override must be a list/],
      ['freezes: { windows: [] }', /freezes must be a list of windows/],
      ['protected: [{ resources: [] }]', /needs at least one address glob/],
      ['protected: { resources: [] }', /protected must be a list/],
      ['risk: { stateful_types: mongodb }', /stateful_types must be a list/],
      ['risk: { size_limits: { medium: 0 } }', /size_limits\.medium must be a whole number/],
      ['risk: { size_limits: { medium: 200 } }', /medium must be lower than high/],
      ['risk: { size_limits: { low: 5 } }', /unknown key "low"/],
      ['break_glass: { grantors: [] }', /needs at least one grantor/],
      ['break_glass: { grantors: [boss] }', /must be admin, user:<name> or group:<group>/],
      ['break_glass: { grantors: [admin], max_hours: 100 }', /max_hours must be between 1 and 72/],
      ['break_glass: { grantors: [admin], notify: [nope] }', /no channel named "nope"/],
      ['summary: { schedule: "0 9 * * 1", notify: [nope] }', /no channel named "nope"/],
      ['summary: { notify: [ops] }', /schedule is required/],
    ];
    for (const [yaml, err] of bad) assert.throws(() => parseServerPolicy(`${channels}${yaml}\nrepos: [{ id: "x" }]`), err, yaml);
    assert.throws(() => parseReposYaml('repos: [{ id: x, stale_base: sometimes }]'), /stale_base must be off, warn, block/);
    assert.throws(() => parseReposYaml('repos: [{ id: x, keep_approval_on_rebase: "yes" }]'), /must be true or false/);
    assert.throws(() => parseServerPolicy(`${channels}repos: [{ id: x, drift: [{ projects: [a], schedule: "0 6 * * *", notify: [ops], fix_pr: "on" }] }]`), /fix_pr must be true or false/);
  });
  test("teriac.yaml can only tighten the approval and base settings", () => {
    const rc = parseRepoConfig('teriac.yaml', 'reapprove_on_change: true\nkeep_approval_on_rebase: false\nstale_base: block\n');
    assert.deepEqual([rc.reapprove_on_change, rc.keep_approval_on_rebase, rc.stale_base], [true, false, 'block']);
    const loose = parseRepoConfig('teriac.yaml', 'reapprove_on_change: false\nkeep_approval_on_rebase: true\n');
    assert.deepEqual([loose.reapprove_on_change, loose.keep_approval_on_rebase], [undefined, undefined], 'loosening is ignored');
    assert.equal(stricterMode('warn', 'off', 'warn'), 'warn');
    assert.equal(stricterMode('warn', 'block', 'warn'), 'block');
    assert.equal(stricterMode('redact', 'fail', 'redact'), 'fail');
    assert.equal(stricterMode(undefined, undefined, 'redact'), 'redact');
  });
});

// ---------------------------------------------------------------------------
describe('emergency access', () => {
  const cfg = { grantors: ['admin', 'user:sre-lead@acme.com', 'group:oncall'], max_hours: 4 };
  test('who may grant', () => {
    assert.equal(isGrantor({ sub: 'x', name: 'X', role: 'admin' }, cfg), true);
    assert.equal(isGrantor({ sub: 'x', name: 'X', role: 'viewer', email: 'SRE-lead@acme.com' }, cfg), true);
    assert.equal(isGrantor({ sub: 'x', name: 'X', role: 'viewer', groups: ['oncall'] }, cfg), true);
    assert.equal(isGrantor({ sub: 'x', name: 'X', role: 'viewer', groups: ['dev'] }, cfg), false);
    assert.equal(isGrantor({ sub: 'x', name: 'X', role: 'admin' }, undefined), false);
  });
  test('grant requests are checked', () => {
    const ok = parseGrantRequest({ user: '@octocat', projects: 'prod/**, envs/prod', actions: ['apply', 'apply_destroy'], bypass: ['approvals'], hours: 2, reason: 'INC-42: roll back the broken load balancer' }, cfg);
    assert.deepEqual(ok, { user: 'octocat', repo: '*', projects: ['prod/**', 'envs/prod'], actions: ['apply', 'apply_destroy'], bypass: ['approvals'], hours: 2, reason: 'INC-42: roll back the broken load balancer' });
    const err = (b: Record<string, unknown>) => (parseGrantRequest({ user: 'a', actions: ['apply'], hours: 1, reason: 'a good reason here', ...b }, cfg) as { error: string }).error;
    assert.match(err({ user: 'not a login!' }), /username/);
    assert.match(err({ actions: [] }), /at least one permission/);
    assert.match(err({ actions: ['launch_missiles'] }), /Unknown permission/);
    assert.match(err({ bypass: ['everything'] }), /Unknown check to skip/);
    assert.match(err({ hours: 5 }), /at most 4 hours/);
    assert.match(err({ hours: 0 }), /more than 0/);
    assert.match(err({ reason: 'oops' }), /at least 10 characters/);
  });
  test('store: active until expiry or revoke; expiry is reported once', async () => {
    const store = new Store(':memory:');
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const g = store.createGrant({ user: 'octocat', repo: '*', projects: ['prod/**'], actions: ['apply'], bypass: [], reason: 'r', grantedBy: 'Ada', expiresAt: soon });
    assert.deepEqual(store.activeGrants().map(x => x.id), [g.id]);
    assert.deepEqual(store.activeGrants(new Date(Date.now() + 7_200_000).toISOString()), []);
    store.markGrantUsed(g.id);
    const used = store.getGrant(g.id)!.usedAt;
    store.markGrantUsed(g.id);
    assert.equal(store.getGrant(g.id)!.usedAt, used, 'first use is kept');
    const sent: unknown[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response('ok'); }) as typeof fetch;
    const watcher = new GrantWatcher({ store, cfg: { grantors: ['admin'], notify: ['ops'] }, channels: { ops: { type: 'webhook', webhook_url_env: 'HOOK' } }, people: [], env: { HOOK: 'https://hook.test' }, fetchImpl });
    await watcher.check(new Date(Date.now() + 7_200_000));
    await watcher.check(new Date(Date.now() + 7_200_000));
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as { event: string }).event, 'teriac.break_glass.expired');
    assert.ok(store.auditLog(5).some(a => a.action === 'break_glass_expired'));
    const g2 = store.createGrant({ user: 'x', repo: '*', projects: [], actions: ['apply'], bypass: [], reason: 'r', grantedBy: 'Ada', expiresAt: soon });
    assert.equal(store.revokeGrant(g2.id, 'Erin'), true);
    assert.equal(store.revokeGrant(g2.id, 'Erin'), false);
    assert.equal(store.activeGrants().some(x => x.id === g2.id), false);
    store.close();
  });
});

// ---------------------------------------------------------------------------
describe('delivery metrics and the weekly summary', () => {
  const seed = () => {
    const store = new Store(':memory:');
    const db = (store as any).db;
    const run = (pr: number, project: string, kind: 'plan' | 'apply', status: 'success' | 'failed', start: string, end: string, user = 'ada') => {
      const id = store.startRun({ repo: 'github.com/acme/infra', pr, project, workspace: 'default', kind, headSha: 'h', user });
      store.finishRun(id, { status, output: '' });
      db.prepare('UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?').run(start, end, id);
    };
    const day = (d: number, h: number) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
    run(1, 'prod', 'plan', 'success', day(2, 9), day(2, 9));
    run(1, 'prod', 'apply', 'success', day(2, 13), day(2, 13));  // 4h after the PR's first run
    run(2, 'dev', 'plan', 'success', day(3, 9), day(3, 9));
    run(2, 'dev', 'apply', 'failed', day(3, 10), day(3, 10));
    run(2, 'dev', 'apply', 'success', day(3, 12), day(3, 12));   // fixed 2h later; lead time 3h
    return { store, day };
  };
  test('lead time, failure rate and time to fix', () => {
    const { store, day } = seed();
    const d = store.delivery(day(1, 0), day(8, 0));
    assert.deepEqual(d.leadTime, { count: 2, p50: 3, p90: 3 });
    assert.equal(d.failureRate, 33.3);
    assert.equal(d.applies, 3);
    assert.deepEqual(d.recovery, { count: 1, p50: 2 });
    assert.ok(store.stats(day(1, 0), day(8, 0)).delivery);
    store.close();
  });
  test('time to fix follows the clock, not row order (imported or restored data)', () => {
    const store = new Store(':memory:');
    const db = (store as any).db;
    const add = (status: 'success' | 'failed', at: string) => {
      const id = store.startRun({ repo: 'r', pr: 1, project: 'p', workspace: 'default', kind: 'apply', headSha: 'h', user: 'u' });
      store.finishRun(id, { status, output: '' });
      db.prepare('UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?').run(at, at, id);
    };
    add('success', '2026-11-03T12:00:00.000Z');  // lower id, but after the failure
    add('success', '2026-11-03T08:00:00.000Z');  // before the failure: not the fix
    add('failed', '2026-11-03T10:00:00.000Z');
    assert.deepEqual(store.delivery('2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z').recovery, { count: 1, p50: 2 });
    store.close();
  });
  test('the summary message', async () => {
    const { store, day } = seed();
    store.acquireLock('github.com/acme/infra', 'old', 'default', 9, 'erin');
    (store as any).db.prepare('UPDATE locks SET created_at = ?').run(day(1, 0));
    const msg = buildSummary(store, 7, new Date(day(8, 0)), 'https://teriac.test');
    assert.equal(msg.title, '📊 teriac: the last 7 days');
    assert.match(msg.lines[0], /\*\*Runs:\*\* 2 plans · 3 applies · 1 failed · 2 PRs/);
    assert.match(msg.lines[1], /PR to applied 3\.0h \(median\) · failed applies 33\.3% · fixed in 2\.0h/);
    assert.ok(msg.lines.some(l => /\*\*Old locks:\*\* `old` by #9 \(7 days\)/.test(l)));
    assert.ok(msg.lines.some(l => /\*\*Drift:\*\* none open/.test(l)));
    assert.equal(msg.url, 'https://teriac.test/#metrics');
    // Scheduled: sends at the matching minute, once.
    const sent: string[] = [];
    const fetchImpl = (async (u: string) => { sent.push(String(u)); return new Response('ok'); }) as typeof fetch;
    const s = new SummaryScheduler({ store, cfg: { schedule: '0 9 * * 1', notify: ['ops'] }, channels: { ops: { type: 'webhook', webhook_url_env: 'HOOK' } }, people: [], env: { HOOK: 'https://hook.test' }, fetchImpl });
    assert.equal(await s.tick(new Date('2026-11-09T08:59:00Z')), null);
    assert.ok(await s.tick(new Date('2026-11-09T09:00:00Z')));
    assert.equal(await s.tick(new Date('2026-11-09T09:00:30Z')), null, 'the minute is claimed once');
    assert.equal(sent.length, 1);
    store.close();
  });
});

// ---------------------------------------------------------------------------
describe('drift-fix PRs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teriac-driftfix-'));
  mkdirSync(join(tmp, 'envs/prod'), { recursive: true });
  writeFileSync(join(tmp, 'envs/prod/main.tf'), [
    'resource "aws_instance" "web" {',
    '  instance_type = "t3.small" # sized for launch',
    '  monitoring    = false',
    '  count_hint    = 2',
    '  ami           = var.ami',
    '  root_block_device {',
    '    volume_size = 20',
    '  }',
    '  tags = { Name = "web" }',
    '}',
    '',
  ].join('\n'));
  const plan = {
    resource_drift: [
      { address: 'aws_instance.web', change: { actions: ['update'],
        before: { instance_type: 't3.small', monitoring: false, count_hint: 2, ami: 'ami-1', volume_size: 20, tags: { Name: 'web' }, tags_all: { Name: 'web' }, root_block_device: [{ volume_size: 20 }] },
        after: { instance_type: 't3.large', monitoring: true, count_hint: 3, ami: 'ami-2', volume_size: 20, tags: { Name: 'web2' }, tags_all: { Name: 'web2' }, root_block_device: [{ volume_size: 50 }] } } },
      { address: 'aws_s3_bucket.gone', change: { actions: ['delete'], before: {}, after: null } },
      { address: 'module.net.aws_vpc.main', change: { actions: ['update'], before: { cidr_block: 'a' }, after: { cidr_block: 'b' } } },
    ],
  };
  test('plain values are edited; everything else is listed for a person', () => {
    const fix = planDriftFix(tmp, 'envs/prod', plan);
    assert.deepEqual(fix.edits.map(e => [e.attribute, e.from, e.to]), [['instance_type', 't3.small', 't3.large'], ['monitoring', false, true], ['count_hint', 2, 3]]);
    const text = fix.files[0].content;
    assert.match(text, /instance_type = "t3\.large" # sized for launch/, 'comments are kept');
    assert.match(text, /monitoring    = true/);
    assert.match(text, /volume_size = 20/, 'nested blocks are not touched');
    assert.match(text, /ami           = var\.ami/);
    const reasons = fix.manual.map(m => `${m.address}: ${m.reason}`);
    assert.ok(reasons.some(r => /ami.*expression or variable/.test(r)));
    assert.ok(reasons.some(r => /tags.*list or block/.test(r)));
    assert.ok(reasons.some(r => /root_block_device.*list or block/.test(r)));
    assert.ok(reasons.some(r => /aws_s3_bucket\.gone: deleted outside Terraform/.test(r)));
    assert.ok(reasons.some(r => /module\.net\.aws_vpc\.main: set inside a module/.test(r)));
    assert.ok(!reasons.some(r => /tags_all/.test(r)), 'computed attributes are skipped');
    const body = driftFixBody('envs/prod', 'main', fix, 'nightly');
    assert.match(body, /\*\*Updated in code\*\*\n- `aws_instance\.web` · `instance_type`: "t3\.small" → "t3\.large"/);
    assert.match(body, /\*\*Needs a person\*\*/);
  });
  test("code that no longer matches the state isn't edited", () => {
    const p2 = { resource_drift: [{ address: 'aws_instance.web', change: { actions: ['update'], before: { instance_type: 't3.micro' }, after: { instance_type: 't3.large' } } }] };
    const fix = planDriftFix(tmp, 'envs/prod', p2);
    assert.equal(fix.edits.length, 0);
    assert.match(fix.manual[0].reason, /doesn't match the last applied value/);
  });
  test('literals', () => {
    assert.deepEqual(parseLiteral('"a b"'), { ok: true, value: 'a b' });
    assert.deepEqual(parseLiteral('"${var.x}"'), { ok: false });
    assert.deepEqual(parseLiteral('"cost $5"'), { ok: true, value: 'cost $5' });
    assert.deepEqual(parseLiteral('-1.5'), { ok: true, value: -1.5 });
    assert.deepEqual(parseLiteral('false'), { ok: true, value: false });
    assert.deepEqual(parseLiteral('local.x'), { ok: false });
  });
  test.after?.(() => rmSync(tmp, { recursive: true, force: true }));
});

// ---------------------------------------------------------------------------
describe('chat messages', () => {
  test('each channel type gets a fitting body', async () => {
    const sent: { url: string; body: any }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { sent.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response('{"ok":true}'); }) as typeof fetch;
    const channels = {
      s: { type: 'slack' as const, webhook_url_env: 'S' }, t: { type: 'teams' as const, webhook_url_env: 'T' },
      d: { type: 'discord' as const, webhook_url_env: 'D' }, g: { type: 'googlechat' as const, webhook_url_env: 'G' }, w: { type: 'webhook' as const, webhook_url_env: 'W' },
    };
    const env = { S: 'https://s.test', T: 'https://t.test', D: 'https://d.test', G: 'https://g.test', W: 'https://w.test' };
    const r = await notifyText(['s', 't', 'd', 'g', 'w', 'missing'], channels, { title: 'Title', lines: ['**bold** and `code`'], event: 'teriac.test', data: { a: 1 } }, { people: [], env, fetchImpl });
    assert.deepEqual(r.map(x => x.ok), [true, true, true, true, true, false]);
    assert.equal(sent[0].body.text, '*Title*\n*bold* and `code`');
    assert.equal(sent[1].body.attachments[0].content.body[0].text, 'Title');
    assert.equal(sent[2].body.content, '**Title**\n**bold** and `code`');
    assert.deepEqual(sent[2].body.allowed_mentions, { parse: [] });
    assert.equal(sent[3].body.text, '*Title*\n*bold* and `code`');
    assert.deepEqual(sent[4].body, { event: 'teriac.test', title: 'Title', lines: ['**bold** and `code`'], data: { a: 1 } });
  });
});

// ---------------------------------------------------------------------------
describe('GitHub: compare, annotations and drift-fix PRs', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cfg = { appId: '123', privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), webhookSecret: 's', apiUrl: 'https://api.github.com', host: 'github.com' };
  const repo = { platform: 'github' as const, host: 'github.com', owner: 'acme', name: 'infra', fullName: 'acme/infra', cloneUrl: '', installationId: 9 };
  const token = () => new Response(JSON.stringify({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600e3).toISOString() }));

  test('compare: files with blob ids, commits with PR numbers, cut-short lists flagged', async () => {
    const fake = (async (url: string) => {
      const u = String(url);
      if (u.endsWith('/access_tokens')) return token();
      if (u.includes('/compare/main...abc')) {
        return new Response(JSON.stringify({
          files: [{ filename: 'a.tf', status: 'modified', sha: 'b1' }, { filename: 'n.tf', status: 'renamed', sha: 'b2', previous_filename: 'o.tf' }],
          commits: [{ sha: 'c1', commit: { message: 'Bump size (#52)\n\nbody', author: { name: 'Ada' } }, author: { login: 'ada' } }],
        }));
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const c = await new GitHubAdapter(cfg, fake).compare(repo, 'main', 'abc');
    assert.deepEqual(c, {
      files: [{ path: 'a.tf', status: 'modified', blob: 'b1', previous: undefined }, { path: 'n.tf', status: 'renamed', blob: 'b2', previous: 'o.tf' }],
      commits: [{ sha: 'c1', message: 'Bump size (#52)', author: 'ada', pr: 52 }],
      truncated: false,
    });
    assert.equal(await new GitHubAdapter(cfg, fake).compare(repo, 'main', 'missing'), null);
  });

  test('check runs carry at most 50 annotations', async () => {
    let body: any;
    const fake = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/access_tokens')) return token();
      if (u.includes('/check-runs?')) return new Response(JSON.stringify({ check_runs: [] }));
      if (init?.method === 'POST' && u.endsWith('/check-runs')) { body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ html_url: 'https://x' })); }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const annotations = Array.from({ length: 60 }, (_, i) => ({ path: 'main.tf', startLine: i + 1, endLine: i + 1, level: 'warning' as const, title: `t${i}`, message: 'm' }));
    await new GitHubAdapter(cfg, fake).setCheck(repo, { name: 'teriac: x', headSha: 'abc', status: 'completed', conclusion: 'neutral', title: 'T', summary: 'S', annotations });
    assert.equal(body.output.annotations.length, 50);
    assert.deepEqual(body.output.annotations[0], { path: 'main.tf', start_line: 1, end_line: 1, annotation_level: 'warning', title: 't0', message: 'm' });
  });

  test('each plan gets a fresh check run, so its notes are not repeated on re-plans', async () => {
    const calls: string[] = [];
    let runs = 0;
    const fake = (async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      const m = init?.method ?? 'GET';
      if (u.pathname.endsWith('/access_tokens')) return token();
      calls.push(`${m} ${u.pathname.replace(/\d+$/, 'N')}`);
      if (m === 'POST' && u.pathname.endsWith('/check-runs')) { runs++; return new Response(JSON.stringify({ id: runs, html_url: `https://x/${runs}` })); }
      if (m === 'GET' && u.pathname.includes('/check-runs')) return new Response(JSON.stringify({ check_runs: [{ id: runs, app: { id: 123 } }] }));
      if (m === 'PATCH') return new Response(JSON.stringify({ html_url: `https://x/${runs}` }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const gh = new GitHubAdapter(cfg, fake);
    const note = [{ path: 'main.tf', startLine: 2, endLine: 2, level: 'failure' as const, title: 't', message: 'm' }];
    for (let i = 0; i < 2; i++) {
      await gh.setCheck(repo, { name: 'teriac: x', headSha: 'abc', status: 'in_progress', title: 'Planning…', summary: '' });
      await gh.setCheck(repo, { name: 'teriac: x', headSha: 'abc', status: 'completed', conclusion: 'neutral', title: 'T', summary: 'S', annotations: note });
    }
    assert.deepEqual(calls, [
      'POST /repos/acme/infra/check-runs', 'GET /repos/acme/infra/commits/abc/check-runs', 'PATCH /repos/acme/infra/check-runs/N',
      'POST /repos/acme/infra/check-runs', 'GET /repos/acme/infra/commits/abc/check-runs', 'PATCH /repos/acme/infra/check-runs/N',
    ]);
    assert.equal(runs, 2, 'one check run per plan');
  });

  test('openPullRequest: branch, commit and PR; skipped when the branch exists', async () => {
    const calls: string[] = [];
    let exists = false;
    const fake = (async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      const m = init?.method ?? 'GET';
      calls.push(`${m} ${u.pathname}`);
      if (u.pathname.endsWith('/access_tokens')) return token();
      if (u.pathname === '/repos/acme/infra/git/ref/heads/teriac/drift-fix/prod') return exists ? new Response('{}') : new Response('{}', { status: 404 });
      if (u.pathname === '/repos/acme/infra/git/ref/heads/main') return new Response(JSON.stringify({ object: { sha: 'base' } }));
      if (u.pathname === '/repos/acme/infra/git/commits/base') return new Response(JSON.stringify({ tree: { sha: 'tree0' } }));
      if (u.pathname === '/repos/acme/infra/git/trees') return new Response(JSON.stringify({ sha: 'tree1' }));
      if (u.pathname === '/repos/acme/infra/git/commits') return new Response(JSON.stringify({ sha: 'c1' }));
      if (u.pathname === '/repos/acme/infra/git/refs') return new Response('{}');
      if (u.pathname === '/repos/acme/infra/pulls') return new Response(JSON.stringify({ html_url: 'https://github.com/acme/infra/pull/9' }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const gh = new GitHubAdapter(cfg, fake);
    const pr = { base: 'main', branch: 'teriac/drift-fix/prod', title: 'Accept drift in prod', body: 'b', files: [{ path: 'prod/main.tf', content: 'x' }] };
    assert.equal(await gh.openPullRequest(repo, pr), 'https://github.com/acme/infra/pull/9');
    assert.deepEqual(calls.filter(c => !c.includes('access_tokens')), [
      'GET /repos/acme/infra/git/ref/heads/teriac/drift-fix/prod', 'GET /repos/acme/infra/git/ref/heads/main', 'GET /repos/acme/infra/git/commits/base',
      'POST /repos/acme/infra/git/trees', 'POST /repos/acme/infra/git/commits', 'POST /repos/acme/infra/git/refs', 'POST /repos/acme/infra/pulls',
    ]);
    exists = true;
    assert.equal(await gh.openPullRequest(repo, pr), null);
  });
});

describe('risk settings across server and repo', () => {
  test('a repo adds stateful types and can only lower size limits', async () => {
    const { App } = await import('../src/app.ts');
    const app = new App({ config: { dataDir: mkdtempSync(join(tmpdir(), 'teriac-risk-')), parallelism: 1, risk: { stateful_types: ['a_*'], size_limits: { medium: 20, high: 80 } } } as any, store: new Store(':memory:'), resolver: {} as any }) as any;
    const r = (repoRisk: unknown) => app.safety({ policy: { risk: repoRisk }, rulesConfig: {} }).risk;
    assert.deepEqual(r({ stateful_types: ['b_*'] }).stateful_types, ['a_*', 'b_*']);
    assert.deepEqual(r({ size_limits: { medium: 10 } }).size_limits, { medium: 10, high: 80 });
    assert.deepEqual(r({ size_limits: { medium: 50, high: 500 } }).size_limits, { medium: 20, high: 80 }, 'raising is ignored');
    assert.deepEqual(r({ size_limits: { high: 15 } }).size_limits, { medium: 14, high: 15 }, 'medium stays below high');
    const plain = new App({ config: { dataDir: mkdtempSync(join(tmpdir(), 'teriac-risk-')), parallelism: 1, risk: { production: ['p/**'] } } as any, store: new Store(':memory:'), resolver: {} as any }) as any;
    assert.deepEqual(plain.safety({ policy: {}, rulesConfig: {} }).risk.size_limits, { medium: 25, high: 100 }, 'defaults when nothing is set');
  });
});
