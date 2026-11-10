const { existsSync, readFileSync, readdirSync } = require('fs');
const { join, dirname } = require('path');
const { spawnSync } = require('child_process');
const { platform, homedir } = require('os');
const { getPaths, getBinTarget, getProviderStore, getCliName, normalizeProvider, checkPathConflict, SHELL_CONFIGS, PATH_MARKER, FISH_CONF, PROVIDER_NAMES, providerFlag, emptyActive, getVersionArgs, displayHome, PATH_LINE } = require('../utils/paths');
// The folder in use: ~/.teriac, or TERIAC_HOME when set.
const HOME_SHOWN = displayHome();
const { P_END, P_OK, P_ERROR, P_WARN, P_INFO } = require('../utils/colors');

const ok   = (label, detail) => { console.log(`  ${P_OK}✔${P_END}  ${label}`); if (detail) console.log(`     ${P_INFO}${detail}${P_END}`); };
const fail = (label, hint)   => { console.log(`  ${P_ERROR}✘${P_END}  ${label}`); if (hint) console.log(`     ${P_WARN}${hint}${P_END}`); };
const info = (label, detail) => { console.log(`  ${P_INFO}–${P_END}  ${label}`); if (detail) console.log(`     ${P_INFO}${detail}${P_END}`); };

// Windows searches the system (Machine) PATH before the User PATH, so a
// terraform installed for all users always beats teriac's User PATH entry.
const inMachinePath = (dir) => {
  const r = spawnSync('powershell',
    ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetEnvironmentVariable("PATH", "Machine")'],
    { stdio: 'pipe', encoding: 'utf-8' });
  if (r.error || r.status !== 0 || !r.stdout) return false;
  const norm = d => d.trim()
    .replace(/%([^%]+)%/g, (m, v) => process.env[v] || m)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
  const target = norm(dir);
  return r.stdout.split(';').some(e => e.trim() && norm(e) === target);
};

// Checks that `terraform` / `tofu` run teriac's copy. Returns the issue count.
const checkResolution = (activeData, isWin) => {
  let issues = 0;
  for (const p of PROVIDER_NAMES) {
    if (!activeData[p]) continue;
    const cli = getCliName(p);
    const conflict = checkPathConflict(p);
    if (conflict.ok) {
      ok(`'${cli}' resolves to teriac-managed binary`);
      continue;
    }
    issues++;
    const got = `Got: ${conflict.resolved}  Expected: ${conflict.expected}`;
    if (isWin && inMachinePath(dirname(conflict.resolved))) {
      fail(`'${cli}' resolves to another install in the system PATH`,
        `${got}\n     Windows checks the system PATH before your User PATH, so teriac can't take over without admin rights.\n` +
        `     Uninstall that ${cli} (e.g. choco uninstall ${cli}) or remove ${dirname(conflict.resolved)} from the system PATH, then restart your terminal.`);
    } else {
      fail(`'${cli}' resolves to wrong binary`,
        `${got}\n     Restart your terminal. If it persists, run: teriac upgrade  to re-anchor PATH`);
    }
  }
  return issues;
};

exports.doctor = async () => {
  const paths = getPaths();
  const isWin = platform() === 'win32';
  let issues = 0;

  console.log(`\n${P_INFO}teriac doctor${P_END}\n`);

  // ── Store ──────────────────────────────────────────────────────────────────
  console.log(`${P_OK}Store${P_END}`);
  for (const p of PROVIDER_NAMES) {
    const store = getProviderStore(p);
    if (existsSync(store)) {
      ok(`${HOME_SHOWN}/store/${p}/ exists`);
    } else {
      fail(`${HOME_SHOWN}/store/${p}/ missing`, 'Run: teriac install latest' + providerFlag(p));
      issues++;
    }
  }

  // ── Active versions & binaries ─────────────────────────────────────────────
  console.log(`\n${P_OK}Active versions${P_END}`);
  let activeData = emptyActive();
  if (existsSync(paths.active)) {
    try { activeData = JSON.parse(readFileSync(paths.active, 'utf-8')); } catch {}
  }

  for (const p of PROVIDER_NAMES) {
    const cli = getCliName(p);
    const binary = getBinTarget(p);
    const active = activeData[p];

    const store = getProviderStore(p);
    const hasInstalled = existsSync(store) &&
      readdirSync(store).filter(f => f !== 'arch.json').length > 0;

    if (!active) {
      if (hasInstalled) {
        fail(`${cli}: no active version set`, `Run: teriac use <version>${providerFlag(p)}`);
        issues++;
      } else {
        info(`${cli}: not set up (no versions installed)`);
      }
      continue;
    }

    ok(`${cli}: active version is ${active}`);

    if (!existsSync(binary)) {
      fail(`${cli}: binary missing at ${binary}`, `Run: teriac use ${active}${providerFlag(p)}`);
      issues++;
      continue;
    }

    ok(`${cli}: binary exists`);

    const result = spawnSync(binary, getVersionArgs(p), { stdio: 'pipe', encoding: 'utf-8' });
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
    const binDir = paths.bin.toLowerCase();
    const inPath = (process.env.PATH || '').split(';').some(e => e.trim().replace(/[\\/]+$/, '').toLowerCase() === binDir);
    if (inPath) {
      ok(`${HOME_SHOWN}/bin is in PATH`);
    } else {
      fail(`${HOME_SHOWN}/bin is not in PATH`, 'Restart your terminal. If it persists, run: teriac upgrade');
      issues++;
    }
    issues += checkResolution(activeData, isWin);
  } else {
    const pathEntries = (process.env.PATH || '').split(':');
    const binDir = paths.bin;

    if (pathEntries.includes(binDir)) {
      ok(`${HOME_SHOWN}/bin is in PATH`);

      const binIdx = pathEntries.indexOf(binDir);
      const systemDirs = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
      const systemIdxs = systemDirs
        .map(d => pathEntries.indexOf(d))
        .filter(i => i >= 0);
      const firstSystem = systemIdxs.length ? Math.min(...systemIdxs) : Infinity;

      if (firstSystem < Infinity) {
        if (binIdx < firstSystem) {
          ok(`${HOME_SHOWN}/bin precedes system dirs in PATH`);
        } else {
          fail(`${HOME_SHOWN}/bin comes AFTER system dirs in PATH`, 'Run: teriac upgrade  to re-anchor PATH');
          issues++;
        }
      }
    } else {
      fail(`${HOME_SHOWN}/bin is not in PATH`, 'Run: teriac upgrade  to re-anchor PATH');
      issues++;
    }

    issues += checkResolution(activeData, isWin);

    const configsWithMarker = [...SHELL_CONFIGS, FISH_CONF].filter(f => {
      if (!existsSync(f)) return false;
      try { return readFileSync(f, 'utf-8').includes(PATH_MARKER); } catch { return false; }
    });
    if (configsWithMarker.length > 0) {
      ok(`PATH block found in shell config`, configsWithMarker.map(f => f.replace(homedir(), '~')).join(', '));
    } else {
      fail('PATH block not found in any shell config', `Add: ${PATH_LINE}  to ~/.zshrc or ~/.bashrc`);
      issues++;
    }
  }

  // ── Cache ─────────────────────────────────────────────────────────────────
  console.log(`\n${P_OK}Cache${P_END}`);
  for (const p of PROVIDER_NAMES) {
    const cacheFile = join(paths.cache, `${p}-versions.json`);
    if (existsSync(cacheFile)) {
      ok(`${p} version cache exists`);
    } else {
      info(`${p} version cache not yet created`, 'Will be built on next: teriac list --remote' + providerFlag(p));
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log();
  if (issues === 0) {
    console.log(`${P_OK}All checks passed. teriac is healthy.${P_END}\n`);
  } else {
    console.log(`${P_ERROR}${issues} issue(s) found. See details above.${P_END}\n`);
    process.exit(1);
  }
};
