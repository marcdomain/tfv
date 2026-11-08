import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/commands.ts';

const names = ['tfv'];
const ok = (body: string) => {
  const r = parseCommand(body, names);
  assert.ok(r && r.ok, `expected ok for ${body}: ${JSON.stringify(r)}`);
  return r.command;
};

test('ignores comments not addressed to tfv', () => {
  assert.equal(parseCommand('looks good to me', names), null);
  assert.equal(parseCommand('', names), null);
  assert.equal(parseCommand('> tfv apply\nquoted', names), null);
});

test('bare name means help', () => {
  assert.equal(ok('tfv').verb, 'help');
});

test('plan with flags', () => {
  const c = ok('tfv plan -p prod/network -w staging --destroy');
  assert.deepEqual(c, { verb: 'plan', project: 'prod/network', workspace: 'staging', destroy: true, override: false, targets: [], extraArgs: [] });
});

test('long flags, = syntax, ./dir normalized', () => {
  const c = ok('tfv plan --project=app -d ./envs/dev/');
  assert.equal(c.project, 'app');
  assert.equal(c.dir, 'envs/dev');
});

test('extra args after --, with quotes', () => {
  assert.deepEqual(ok('tfv plan -- -var "env=prod east" -refresh=false').extraArgs, ['-var', 'env=prod east', '-refresh=false']);
});

test('@mention and case', () => {
  assert.equal(parseCommand('terraform apply -p x', names), null, 'only tfv commands');
  assert.equal(ok('@tfv plan').verb, 'plan');
  assert.equal(ok('TFV PLAN').verb, 'plan');
});

test('errors', () => {
  assert.deepEqual(parseCommand('tfv deploy', names), { ok: false, error: 'Unknown command `deploy`. Try `tfv help`.' });
  assert.equal((parseCommand('tfv plan -p', names) as { error: string }).error, '`-p` needs a value');
  assert.equal((parseCommand('tfv plan --yolo', names) as { error: string }).error, 'Unknown flag `--yolo`');
  assert.equal((parseCommand('tfv apply --destroy', names) as { error: string }).error, '`--destroy` only works with plan');
  assert.equal((parseCommand('tfv apply -- -var x=1', names) as { error: string }).error, 'Extra arguments only work with plan');
});

test('targets: repeatable, need a project, plan only, addresses only', () => {
  assert.deepEqual(ok('tfv plan -p envs/prod -t aws_s3_bucket.logs --target=module.net.aws_subnet.a[0] -t \'aws_instance.web["blue"]\'').targets,
    ['aws_s3_bucket.logs', 'module.net.aws_subnet.a[0]', 'aws_instance.web["blue"]']);
  assert.match((parseCommand('tfv plan -t aws_s3_bucket.logs', names) as { error: string }).error, /Targets need a project/);
  assert.match((parseCommand('tfv apply -p x -t aws_s3_bucket.logs', names) as { error: string }).error, /Targets are set when planning/);
  // A target can't smuggle in another flag or shell text.
  assert.match((parseCommand('tfv plan -p x -t=-var=evil', names) as { error: string }).error, /is not a resource address/);
  assert.match((parseCommand('tfv plan -p x -t "a b"', names) as { error: string }).error, /is not a resource address/);
  assert.match((parseCommand('tfv plan -p x -t $(whoami)', names) as { error: string }).error, /is not a resource address/);
});

test('help lists only what the server allows', async () => {
  const { helpText } = await import('../src/commands.ts');
  assert.match(helpText('tfv'), /\| `tfv apply` \| Apply every planned project/);
  const strict = helpText('tfv', true);
  assert.doesNotMatch(strict, /\| `tfv apply` \|/);
  assert.match(strict, /\| `tfv apply -p <project>` \| Apply one project \(this server applies one project at a time\) \|/);
});
