'use strict';

/**
 * Smoke-import tests — verifies every module loads without ReferenceErrors,
 * missing requires, or other module-level exceptions.
 */

const modules = [
  '../lib/modules/install',
  '../lib/modules/use',
  '../lib/modules/list',
  '../lib/modules/remote',
  '../lib/modules/remove',
  '../lib/modules/switch',
  '../lib/modules/current',
  '../lib/modules/pin',
  '../lib/modules/upgrade',
  '../lib/modules/shell-init',
  '../lib/modules/terraform-command',
  '../lib/utils/paths',
  '../lib/utils/store',
  '../lib/utils/formatVersions',
  '../lib/utils/colors',
  '../lib/commands/install',
  '../lib/commands/use',
  '../lib/commands/list',
  '../lib/commands/remove',
  '../lib/commands/switch',
  '../lib/commands/current',
  '../lib/commands/pin',
  '../lib/commands/upgrade',
  '../lib/commands/shell-init',
  '../lib/commands/plan',
  '../lib/commands/apply',
  '../lib/commands/destroy',
  '../lib/commands/init',
  '../lib/commands/validate',
  '../lib/commands/fmt',
];

describe('module imports', () => {
  test.each(modules)('%s loads without error', (mod) => {
    expect(() => require(mod)).not.toThrow();
  });
});
