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

test('Terraform commands: one project, checked arguments, nothing passed through', async () => {
  const { toolArgs, TOOL_ACTION } = await import('../src/commands.ts');
  const c = (body: string) => ok(body);
  assert.deepEqual(toolArgs(c('tfv state list -p infra/dev')), ['state', 'list']);
  assert.deepEqual(toolArgs(c('tfv state show -p infra/dev module.bucket.aws_s3_bucket.this[0]')), ['state', 'show', 'module.bucket.aws_s3_bucket.this[0]']);
  assert.deepEqual(toolArgs(c('tfv state rm -p infra/dev aws_s3_bucket.a aws_s3_bucket.b')), ['state', 'rm', 'aws_s3_bucket.a', 'aws_s3_bucket.b']);
  assert.deepEqual(toolArgs(c('tfv state mv -p infra/dev aws_s3_bucket.a aws_s3_bucket.b')), ['state', 'mv', 'aws_s3_bucket.a', 'aws_s3_bucket.b']);
  assert.deepEqual(toolArgs(c('tfv import -p infra/dev aws_s3_bucket.a my-bucket')), ['import', '-input=false', '-no-color', 'aws_s3_bucket.a', 'my-bucket']);
  assert.deepEqual(toolArgs(c('tfv output -p infra/dev bucket')), ['output', '-no-color', 'bucket']);
  assert.deepEqual(toolArgs(c('tfv force-unlock -p infra/dev 1a2b-3c')), ['force-unlock', '-force', '1a2b-3c']);
  assert.equal(TOOL_ACTION['state rm'], 'state_rm');
  assert.equal(TOOL_ACTION['force-unlock'], 'force_unlock');
  assert.equal(TOOL_ACTION['state list'], 'state_list');

  const err = (body: string) => (parseCommand(body, names) as { error: string }).error;
  assert.match(err('tfv state list'), /runs on one project/);
  assert.match(err('tfv state blah -p x'), /needs one of: list, show, rm, mv/);
  assert.match(err('tfv state show -p x'), /Usage: `tfv state show -p <project> <address>`/);
  assert.match(err('tfv state mv -p x a.b'), /Usage/);
  assert.match(err('tfv import -p x aws_s3_bucket.a -chdir=/'), /Unknown flag/);
  assert.match(err('tfv state rm -p x "a.b; rm -rf /"'), /Usage/);
  assert.match(err('tfv output -p x -json'), /Unknown flag/);
  assert.match(err('tfv show -p x extra'), /Usage/);
  assert.match(err('tfv state list -p x -t a.b'), /Only `-p`, `-d` and `-w` work/);
  assert.match(err('tfv console -p x'), /Unknown command `console`/);
  assert.match(err('tfv plan extra'), /Unexpected `extra`/);
});

test('plan --refresh-only and --replace', () => {
  const c = ok('tfv plan -p infra/dev --replace aws_s3_bucket.a --replace aws_s3_bucket.b');
  assert.deepEqual(c.replace, ['aws_s3_bucket.a', 'aws_s3_bucket.b']);
  assert.equal(ok('tfv plan -p infra/dev --refresh-only').refreshOnly, true);
  assert.match((parseCommand('tfv apply --replace a.b', names) as { error: string }).error, /only work with plan/);
  assert.match((parseCommand('tfv plan --refresh-only --destroy', names) as { error: string }).error, /can't be combined/);
  assert.match((parseCommand('tfv plan --replace -x', names) as { error: string }).error, /needs a value/);
});
