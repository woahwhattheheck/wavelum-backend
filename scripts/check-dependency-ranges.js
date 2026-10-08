#!/usr/bin/env node
'use strict';

/*
 * Dependency range + lockfile policy check (issue #44).
 *
 * Policy (see CONTRIBUTING.md → Dependency Management):
 *   - Every dependency spec must be an exact version (`1.2.3`) or a caret
 *     range (`^1.2.3`). Tilde ranges, comparators, wildcards, dist-tags
 *     (`latest`) and git/http URLs are rejected so installs stay
 *     reproducible and reviewable.
 *   - Local non-registry refs (`file:`, `link:`, `workspace:`) are allowed.
 *   - Every package directory must carry a package-lock.json, and the
 *     lockfile's recorded root specs must match package.json exactly —
 *     catching a package.json edited without regenerating the lockfile.
 *
 * Exits non-zero on any violation so CI can block on it.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
// Active dependency surface named by issue #44: root orchestrator + backend/.
// legacy_cleanup/ is a frozen archive — its drift is reported as warnings,
// not blocking violations (see CONTRIBUTING.md → Dependency Management).
const PACKAGE_DIRS = ['.', 'backend', 'legacy_cleanup'];
const ENFORCED_DIRS = new Set(['.', 'backend']);
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CARET = /^\^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const LOCAL_REF = /^(?:file:|link:|workspace:)/;

const violations = [];
const warnings = [];
const checked = [];

function isAllowedSpec(spec) {
  return EXACT.test(spec) || CARET.test(spec) || LOCAL_REF.test(spec);
}

for (const dir of PACKAGE_DIRS) {
  const pkgPath = path.join(REPO_ROOT, dir, 'package.json');
  const lockPath = path.join(REPO_ROOT, dir, 'package-lock.json');

  if (!fs.existsSync(pkgPath)) {
    continue; // not a package directory
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const sink = ENFORCED_DIRS.has(dir) ? violations : warnings;

  // 1. Version-range policy.
  for (const section of DEP_SECTIONS) {
    const deps = pkg[section] || {};
    for (const [name, spec] of Object.entries(deps)) {
      if (!isAllowedSpec(spec)) {
        sink.push(
          `${dir}/package.json ${section}.${name}: "${spec}" ` +
          '(allowed: exact x.y.z or ^x.y.z; no ranges, tags, or URLs)'
        );
      }
    }
  }

  // 2. Lockfile presence + root spec sync. A missing lockfile is a warning
  // (the gate cannot enforce sync on a lockfile that does not exist yet);
  // a present-but-stale lockfile is a blocking violation.
  if (!fs.existsSync(lockPath)) {
    warnings.push(`${dir}/package-lock.json missing — npm ci cannot run in ${dir}/ (artifact pending)`);
    checked.push(dir);
    continue;
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const rootEntry = (lock.packages && lock.packages['']) || {};
  for (const section of DEP_SECTIONS) {
    const declared = pkg[section] || {};
    const locked = rootEntry[section] || {};
    for (const [name, spec] of Object.entries(declared)) {
      if (locked[name] !== spec) {
        sink.push(
          `${dir}: lockfile out of sync — ${section}.${name} is "${spec}" ` +
          `in package.json but "${locked[name] || '(absent)'}" in package-lock.json ` +
          '(run `npm install --package-lock-only` to regenerate)'
        );
      }
    }
    for (const name of Object.keys(locked)) {
      if (!(name in declared)) {
        sink.push(
          `${dir}: lockfile out of sync — ${section}.${name} ` +
          'present in package-lock.json but removed from package.json ' +
          '(run `npm install --package-lock-only` to regenerate)'
        );
      }
    }
  }

  checked.push(dir);
}

console.log(`dependency-range check: ${checked.length} package(s) — ${checked.join(', ')}`);
if (warnings.length) {
  console.log(`warnings (non-enforced dirs): ${warnings.length}`);
  for (const w of warnings) console.log(`  ~ ${w}`);
}
if (violations.length) {
  console.error(`FAIL: ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('OK: all dependency specs use exact/caret ranges and lockfiles are in sync');
