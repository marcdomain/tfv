const yargs = require('yargs/yargs');

jest.mock('../lib/modules/remove', () => ({ remove: jest.fn(async () => {}) }));
const { remove } = require('../lib/modules/remove');
const cmd = require('../lib/commands/remove');

const run = (args) => yargs(args).command(cmd).exitProcess(false).fail((msg, err) => { throw err || new Error(msg); }).parseAsync();

beforeEach(() => remove.mockClear());

test('passes the version to remove', async () => {
  await run(['remove', '1.6.6']);
  expect(remove).toHaveBeenCalledWith(['1.6.6'], 'terraform');
});

test('passes several versions, and the rm alias works', async () => {
  await run(['rm', '1.5.7', '1.4.6', '--provider', 'tofu']);
  expect(remove).toHaveBeenCalledWith(['1.5.7', '1.4.6'], 'tofu');
});

test('keeps versions as strings', async () => {
  await run(['remove', '1.10']);
  expect(remove).toHaveBeenCalledWith(['1.10'], 'terraform');
});

// Versions like 1.10 must not be read as the number 1.1.
describe.each(['use', 'install', 'exec'])('%s keeps 1.10 as text', (name) => {
  test('1.10 stays 1.10', () => {
    const mod = require(`../lib/commands/${name}`);
    let got;
    yargs([name, '1.10']).command({ ...mod, handler: (a) => { got = a.ver; } }).exitProcess(false).parse();
    expect(got).toBe('1.10');
  });
});
