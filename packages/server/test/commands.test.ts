import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/commands.ts';

const names = ['teriac'];
const ok = (body: string) => {
  const r = parseCommand(body, names);
  assert.ok(r && r.ok, `expected ok for ${body}: ${JSON.stringify(r)}`);
  return r.command;
};

test('ignores comments not addressed to teriac', () => {
  assert.equal(parseCommand('looks good to me', names), null);
  assert.equal(parseCommand('', names), null);
  assert.equal(parseCommand('> teriac apply\nquoted', names), null);
});

test('bare name means help', () => {
  assert.equal(ok('teriac').verb, 'help');
});

test('plan with flags', () => {
  const c = ok('teriac plan -p prod/network -w staging --destroy');
  assert.deepEqual(c, { verb: 'plan', project: 'prod/network', workspace: 'staging', destroy: true, override: false, targets: [], extraArgs: [] });
});

test('long flags, = syntax, ./dir normalized', () => {
  const c = ok('teriac plan --project=app -d ./envs/dev/');
  assert.equal(c.project, 'app');
  assert.equal(c.dir, 'envs/dev');
});

test('extra args after --, with quotes', () => {
  assert.deepEqual(ok('teriac plan -- -var "env=prod east" -refresh=false').extraArgs, ['-var', 'env=prod east', '-refresh=false']);
});

test('@mention and case', () => {
  assert.equal(parseCommand('terraform apply -p x', names), null, 'only teriac commands');
  assert.equal(ok('@teriac plan').verb, 'plan');
  assert.equal(ok('TERIAC PLAN').verb, 'plan');
});

test('errors', () => {
  assert.deepEqual(parseCommand('teriac deploy', names), { ok: false, error: 'Unknown command `deploy`. Try `teriac help`.' });
  assert.equal((parseCommand('teriac plan -p', names) as { error: string }).error, '`-p` needs a value');
  assert.equal((parseCommand('teriac plan --yolo', names) as { error: string }).error, 'Unknown flag `--yolo`');
  assert.equal((parseCommand('teriac apply --destroy', names) as { error: string }).error, '`--destroy` only works with plan');
  assert.equal((parseCommand('teriac apply -- -var x=1', names) as { error: string }).error, 'Extra arguments only work with plan');
});

test('targets: repeatable, need a project, plan only, addresses only', () => {
  assert.deepEqual(ok('teriac plan -p envs/prod -t aws_s3_bucket.logs --target=module.net.aws_subnet.a[0] -t \'aws_instance.web["blue"]\'').targets,
    ['aws_s3_bucket.logs', 'module.net.aws_subnet.a[0]', 'aws_instance.web["blue"]']);
  assert.match((parseCommand('teriac plan -t aws_s3_bucket.logs', names) as { error: string }).error, /Targets need a project/);
  assert.match((parseCommand('teriac apply -p x -t aws_s3_bucket.logs', names) as { error: string }).error, /Targets are set when planning/);
  // A target can't smuggle in another flag or shell text.
  assert.match((parseCommand('teriac plan -p x -t=-var=evil', names) as { error: string }).error, /is not a resource address/);
  assert.match((parseCommand('teriac plan -p x -t "a b"', names) as { error: string }).error, /is not a resource address/);
  assert.match((parseCommand('teriac plan -p x -t $(whoami)', names) as { error: string }).error, /is not a resource address/);
});

test('help lists only what the server allows', async () => {
  const { helpText } = await import('../src/commands.ts');
  assert.match(helpText('teriac'), /\| `teriac apply` \| Apply every planned project/);
  const strict = helpText('teriac', true);
  assert.doesNotMatch(strict, /\| `teriac apply` \|/);
  assert.match(strict, /\| `teriac apply -p <project>` \| Apply one project \(this server applies one project at a time\) \|/);
});

test('Terraform commands: one project, checked arguments, nothing passed through', async () => {
  const { toolArgs, TOOL_ACTION } = await import('../src/commands.ts');
  const c = (body: string) => ok(body);
  assert.deepEqual(toolArgs(c('teriac state list -p infra/dev')), ['state', 'list']);
  assert.deepEqual(toolArgs(c('teriac state show -p infra/dev module.bucket.aws_s3_bucket.this[0]')), ['state', 'show', 'module.bucket.aws_s3_bucket.this[0]']);
  assert.deepEqual(toolArgs(c('teriac state rm -p infra/dev aws_s3_bucket.a aws_s3_bucket.b')), ['state', 'rm', 'aws_s3_bucket.a', 'aws_s3_bucket.b']);
  assert.deepEqual(toolArgs(c('teriac state mv -p infra/dev aws_s3_bucket.a aws_s3_bucket.b')), ['state', 'mv', 'aws_s3_bucket.a', 'aws_s3_bucket.b']);
  assert.deepEqual(toolArgs(c('teriac import -p infra/dev aws_s3_bucket.a my-bucket')), ['import', '-input=false', '-no-color', 'aws_s3_bucket.a', 'my-bucket']);
  assert.deepEqual(toolArgs(c('teriac output -p infra/dev bucket')), ['output', '-no-color', 'bucket']);
  assert.deepEqual(toolArgs(c('teriac force-unlock -p infra/dev 1a2b-3c')), ['force-unlock', '-force', '1a2b-3c']);
  assert.equal(TOOL_ACTION['state rm'], 'state_rm');
  assert.equal(TOOL_ACTION['force-unlock'], 'force_unlock');
  assert.equal(TOOL_ACTION['state list'], 'state_list');

  const err = (body: string) => (parseCommand(body, names) as { error: string }).error;
  assert.match(err('teriac state list'), /runs on one project/);
  assert.match(err('teriac state blah -p x'), /needs one of: list, show, rm, mv/);
  assert.match(err('teriac state show -p x'), /Usage: `teriac state show -p <project> <address>`/);
  assert.match(err('teriac state mv -p x a.b'), /Usage/);
  assert.match(err('teriac import -p x aws_s3_bucket.a -chdir=/'), /Unknown flag/);
  assert.match(err('teriac state rm -p x "a.b; rm -rf /"'), /Usage/);
  assert.match(err('teriac output -p x -json'), /Unknown flag/);
  assert.match(err('teriac show -p x extra'), /Usage/);
  assert.match(err('teriac state list -p x -t a.b'), /Only `-p`, `-d` and `-w` work/);
  assert.match(err('teriac console -p x'), /Unknown command `console`/);
  assert.match(err('teriac plan extra'), /Unexpected `extra`/);
});

test('plan --refresh-only and --replace', () => {
  const c = ok('teriac plan -p infra/dev --replace aws_s3_bucket.a --replace aws_s3_bucket.b');
  assert.deepEqual(c.replace, ['aws_s3_bucket.a', 'aws_s3_bucket.b']);
  assert.equal(ok('teriac plan -p infra/dev --refresh-only').refreshOnly, true);
  assert.match((parseCommand('teriac apply --replace a.b', names) as { error: string }).error, /only work with plan/);
  assert.match((parseCommand('teriac plan --refresh-only --destroy', names) as { error: string }).error, /can't be combined/);
  assert.match((parseCommand('teriac plan --replace -x', names) as { error: string }).error, /needs a value/);
});

test('only teriac commands are picked up', () => {
  const names = ['teriac'];
  const a = parseCommand('teriac plan -p infra/dev', names);
  assert.ok(a && a.ok && a.command.verb === 'plan' && a.command.project === 'infra/dev');
  assert.equal(parseCommand('atlantis plan', names), null);
  assert.equal(parseCommand('terraform plan', names), null);
});
