const { existsSync, readFileSync, readdirSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');
const { platform, homedir } = require('os');
const { getPaths, getBinTarget, getProviderStore, getCliName, normalizeProvider, checkPathConflict } = require('../utils/paths');
const { P_END, P_OK, P_ERROR, P_WARN, P_INFO } = require('../utils/colors');

const SHELL_CONFIGS = [
  join(homedir(), '.zshrc'),
  join(homedir(), '.bashrc'),
  join(homedir(), '.bash_profile'),
  join(homedir(), '.profile'),
];
const PATH_MARKER = '# tfv - terraform version manager';

const ok   = (label, detail) => { console.log(`  ${P_OK}✔${P_END}  ${label}`); if (detail) console.log(`     ${P_INFO}${detail}${P_END}`); };
const fail = (label, hint)   => { console.log(`  ${P_ERROR}✘${P_END}  ${label}`); if (hint) console.log(`     ${P_WARN}${hint}${P_END}`); };
const info = (label, detail) => { console.log(`  ${P_INFO}–${P_END}  ${label}`); if (detail) console.log(`     ${P_INFO}${detail}${P_END}`); };

exports.doctor = async () => {
  const paths = getPaths();
  const isWin = platform() === 'win32';
  let issues = 0;

  console.log(`\n${P_INFO}tfv doctor${P_END}\n`);

  // ── Store ──────────────────────────────────────────────────────────────────
  console.log(`${P_OK}Store${P_END}`);
  for (const p of ['terraform', 'opentofu']) {
    const store = getProviderStore(p);
    if (existsSync(store)) {
      ok(`~/.tfv/store/${p}/ exists`);
    } else {
      fail(`~/.tfv/store/${p}/ missing`, 'Run: tfv install latest' + (p === 'opentofu' ? ' --provider tofu' : ''));
      issues++;
    }
  }

  // ── Active versions & binaries ─────────────────────────────────────────────
  console.log(`\n${P_OK}Active versions${P_END}`);
  let activeData = { terraform: null, opentofu: null };
  if (existsSync(paths.active)) {
    try { activeData = JSON.parse(readFileSync(paths.active, 'utf-8')); } catch {}
  }

  for (const p of ['terraform', 'opentofu']) {
    const cli = getCliName(p);
    const binary = getBinTarget(p);
    const active = activeData[p];

    const store = getProviderStore(p);
    const hasInstalled = existsSync(store) &&
      readdirSync(store).filter(f => f !== 'arch.json').length > 0;

    if (!active) {
      if (hasInstalled) {
        fail(`${cli}: no active version set`, `Run: tfv use <version>${p === 'opentofu' ? ' --provider tofu' : ''}`);
        issues++;
      } else {
        info(`${cli}: not set up (no versions installed)`);
      }
      continue;
    }

    ok(`${cli}: active version is ${active}`);

    if (!existsSync(binary)) {
      fail(`${cli}: binary missing at ${binary}`, `Run: tfv use ${active}${p === 'opentofu' ? ' --provider tofu' : ''}`);
      issues++;
      continue;
    }

    ok(`${cli}: binary exists`);

    const result = spawnSync(binary, ['version'], { stdio: 'pipe', encoding: 'utf-8' });
    if (result.status === 0 && result.stdout) {
      ok(`${cli}: executes  (${result.stdout.split('\n')[0].trim()})`);
    } else {
      fail(`${cli}: binary failed to execute`, result.stderr ? result.stderr.trim() : 'Unknown error');
      issues++;
    }
  }

  // ── PATH ──────────────────────────────────────────────────────────────────
  console.log(`\n${P_OK}PATH${P_END}`);

  if (isWin) {
    info('PATH check skipped on Windows (managed via User PATH registry key)');
  } else {
    const pathEntries = (process.env.PATH || '').split(':');
    const tfvBin = paths.bin;

    if (pathEntries.includes(tfvBin)) {
      ok('~/.tfv/bin is in PATH');

      const tfvIdx = pathEntries.indexOf(tfvBin);
      const systemDirs = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
      const systemIdxs = systemDirs
        .map(d => pathEntries.indexOf(d))
        .filter(i => i >= 0);
      const firstSystem = systemIdxs.length ? Math.min(...systemIdxs) : Infinity;

      if (firstSystem < Infinity) {
        if (tfvIdx < firstSystem) {
          ok('~/.tfv/bin precedes system dirs in PATH');
        } else {
          fail('~/.tfv/bin comes AFTER system dirs in PATH', 'Run: tfv upgrade  to re-anchor PATH');
          issues++;
        }
      }
    } else {
      fail('~/.tfv/bin is not in PATH', 'Run: tfv upgrade  to re-anchor PATH');
      issues++;
    }

    for (const p of ['terraform', 'opentofu']) {
      const active = activeData[p];
      if (!active) continue;
      const cli = getCliName(p);
      const conflict = checkPathConflict(p);
      if (conflict.ok) {
        ok(`'${cli}' resolves to tfv-managed binary`);
      } else {
        fail(`'${cli}' resolves to wrong binary`, `Got: ${conflict.resolved}  Expected: ${conflict.expected}`);
        issues++;
      }
    }

    const configsWithMarker = SHELL_CONFIGS.filter(f => {
      if (!existsSync(f)) return false;
      try { return readFileSync(f, 'utf-8').includes(PATH_MARKER); } catch { return false; }
    });
    if (configsWithMarker.length > 0) {
      ok(`PATH block found in shell config`, configsWithMarker.map(f => f.replace(homedir(), '~')).join(', '));
    } else {
      fail('PATH block not found in any shell config', `Add: export PATH="$HOME/.tfv/bin:$PATH"  to ~/.zshrc or ~/.bashrc`);
      issues++;
    }
  }

  // ── Cache ─────────────────────────────────────────────────────────────────
  console.log(`\n${P_OK}Cache${P_END}`);
  for (const p of ['terraform', 'opentofu']) {
    const cacheFile = join(paths.cache, `${p}-versions.json`);
    if (existsSync(cacheFile)) {
      ok(`${p} version cache exists`);
    } else {
      info(`${p} version cache not yet created`, 'Will be built on next: tfv list --remote' + (p === 'opentofu' ? ' --provider tofu' : ''));
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log();
  if (issues === 0) {
    console.log(`${P_OK}All checks passed. tfv is healthy.${P_END}\n`);
  } else {
    console.log(`${P_ERROR}${issues} issue(s) found. See details above.${P_END}\n`);
    process.exit(1);
  }
};
