#!/usr/bin/env node
'use strict';

/*
 * Dependency metrics, license and deprecation report (issue #44).
 *
 * Reads each package-lock.json — npm v3 lockfiles store `license` and
 * `deprecated` metadata per package — and prints:
 *   - direct + total dependency counts
 *   - license distribution, flagging copyleft/unknown licenses
 *   - packages carrying a deprecation notice
 *
 * This step is intentionally informational only ("alert only,
 * non-blocking" per the issue): it always exits 0. Blocking policy
 * enforcement lives in check-dependency-ranges.js and `npm ci --dry-run`.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PACKAGE_DIRS = ['.', 'backend', 'legacy_cleanup'];
const COPYLEFT = /GPL|AGPL|LGPL|SSPL|MPL|EPL|CC-BY-SA|CC0|WTFPL|UNLICENSED|UNLICENSE/i;

for (const dir of PACKAGE_DIRS) {
  const lockPath = path.join(REPO_ROOT, dir, 'package-lock.json');
  const pkgPath = path.join(REPO_ROOT, dir, 'package.json');
  if (!fs.existsSync(lockPath) || !fs.existsSync(pkgPath)) continue;

  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const packages = lock.packages || {};
  const rootEntry = packages[''] || {};
  const direct =
    Object.keys(rootEntry.dependencies || {}).length +
    Object.keys(rootEntry.devDependencies || {}).length;
  const total = Object.keys(packages).filter((k) => k !== '').length;

  const histogram = new Map();
  const flagged = [];
  const deprecated = [];
  let noLicense = 0;

  for (const [loc, meta] of Object.entries(packages)) {
    if (loc === '') continue;
    const name = loc.split('node_modules/').pop();
    const lic = meta.license || meta.licence;
    if (!lic) {
      noLicense += 1;
      flagged.push(`${name} (license field missing)`);
      continue;
    }
    const list = (Array.isArray(lic) ? lic : [lic]).map((l) =>
      typeof l === 'string' ? l : (l && (l.type || l.name)) || JSON.stringify(l)
    );
    for (const l of list) {
      histogram.set(l, (histogram.get(l) || 0) + 1);
      if (COPYLEFT.test(l)) flagged.push(`${name} (${l})`);
    }
    if (meta.deprecated) {
      deprecated.push(`${name} — ${String(meta.deprecated).slice(0, 100)}`);
    }
  }

  console.log(`\n=== ${dir === '.' ? '(root)' : dir} ===`);
  console.log(`dependencies: ${direct} direct / ${total} total resolved`);
  console.log('licenses:');
  for (const [lic, count] of [...histogram.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${lic}: ${count}`);
  }
  console.log(`copyleft/unknown licenses (ALERT ONLY — not blocking): ${flagged.length}`);
  for (const f of flagged.slice(0, 20)) console.log(`  - ${f}`);
  if (flagged.length > 20) console.log(`  ...and ${flagged.length - 20} more`);
  if (noLicense) console.log(`  (${noLicense} packages omit a license field — included above)`);
  console.log(`deprecated packages: ${deprecated.length}`);
  for (const d of deprecated.slice(0, 20)) console.log(`  - ${d}`);
  if (deprecated.length > 20) console.log(`  ...and ${deprecated.length - 20} more`);
}

// Informational report — always succeeds.
process.exit(0);
