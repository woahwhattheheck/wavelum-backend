#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();
const packageRoots = [
  { label: 'root', manifest: 'package.json', lock: 'package-lock.json' },
  { label: 'backend', manifest: 'backend/package.json', lock: 'backend/package-lock.json' },
];

// Direct registry dependencies use caret ranges. If an incompatibility ever
// requires an exact pin, add "root-or-backend:package-name" here with the PR
// rationale rather than weakening the policy globally.
const exactPinAllowlist = new Set();

const caretRange = /^\^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const exactRange = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`${relativePath}: ${error.message}`);
  }
}

function stableObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sameObject(left = {}, right = {}) {
  return JSON.stringify(stableObject(left)) === JSON.stringify(stableObject(right));
}

function sectionDiff(manifestSection = {}, lockSection = {}) {
  const keys = new Set([...Object.keys(manifestSection), ...Object.keys(lockSection)]);
  return [...keys]
    .sort()
    .filter((key) => manifestSection[key] !== lockSection[key])
    .map(
      (key) =>
        `${key}: manifest=${manifestSection[key] ?? '<missing>'}, lock=${lockSection[key] ?? '<missing>'}`,
    );
}

function validateDirectRange(label, dependency, spec, errors) {
  if (caretRange.test(spec)) return;
  if (exactRange.test(spec) && exactPinAllowlist.has(`${label}:${dependency}`)) return;

  if (exactRange.test(spec)) {
    errors.push(
      `${label}: ${dependency} uses exact version ${spec}; direct registry dependencies use caret ranges unless explicitly added to exactPinAllowlist`,
    );
    return;
  }

  errors.push(
    `${label}: ${dependency} uses unsupported direct dependency spec ${spec}; use a caret semver range or document an exact-pin exception`,
  );
}

function loadPackage(config) {
  return {
    ...config,
    manifest: readJson(config.manifest),
    lockData: readJson(config.lock),
  };
}

function validate() {
  const errors = [];

  for (const config of packageRoots) {
    let pkg;
    try {
      pkg = loadPackage(config);
    } catch (error) {
      errors.push(error.message);
      continue;
    }

    const lockRoot = pkg.lockData.packages?.[''];
    if (pkg.lockData.lockfileVersion !== 3) {
      errors.push(
        `${pkg.label}: expected npm lockfileVersion 3, found ${pkg.lockData.lockfileVersion ?? '<missing>'}`,
      );
    }
    if (!lockRoot) {
      errors.push(`${pkg.label}: ${pkg.lock} is missing packages[""] metadata`);
      continue;
    }

    for (const section of ['dependencies', 'devDependencies']) {
      const manifestSection = pkg.manifest[section] ?? {};
      const lockSection = lockRoot[section] ?? {};

      if (!sameObject(manifestSection, lockSection)) {
        const diffs = sectionDiff(manifestSection, lockSection);
        errors.push(
          `${pkg.label}: ${section} is out of sync with ${pkg.lock}:\n  ${diffs.join('\n  ')}`,
        );
      }

      for (const [dependency, spec] of Object.entries(manifestSection)) {
        validateDirectRange(pkg.label, dependency, spec, errors);
      }
    }
  }

  if (errors.length > 0) {
    console.error('Dependency metadata validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log('Dependency metadata validation passed for root and backend package roots.');
}

function strongCopyleftLicense(license) {
  if (typeof license !== 'string') return false;
  return /(?:^|[^L])(?:AGPL|GPL)-(?:1\.0|2\.0|3\.0)(?:-only|-or-later)?(?:$|[^A-Za-z0-9])/i.test(
    license,
  );
}

function metricsFor(pkg) {
  const lockEntries = Object.entries(pkg.lockData.packages ?? {}).filter(
    ([location]) => location !== '',
  );
  const strongCopyleft = [];
  let unknownLicense = 0;

  for (const [location, metadata] of lockEntries) {
    const license =
      typeof metadata.license === 'string' && metadata.license.trim()
        ? metadata.license.trim()
        : 'UNKNOWN';

    if (license === 'UNKNOWN') unknownLicense += 1;
    if (strongCopyleftLicense(license)) {
      strongCopyleft.push(
        `${location.replace(/^node_modules\//, '')} (${license})`,
      );
    }
  }

  return {
    label: pkg.label,
    totalPackages: lockEntries.length,
    directDependencies: Object.keys(pkg.manifest.dependencies ?? {}).length,
    directDevDependencies: Object.keys(pkg.manifest.devDependencies ?? {}).length,
    unknownLicense,
    strongCopyleft,
  };
}

function parseOutdated(relativePath) {
  if (!relativePath) return null;
  const absolutePath = path.join(repoRoot, relativePath);

  if (!fs.existsSync(absolutePath)) {
    return { path: relativePath, count: 0, unavailable: true };
  }

  const raw = fs.readFileSync(absolutePath, 'utf8').trim();
  if (!raw) return { path: relativePath, count: 0, unavailable: true };

  try {
    const data = JSON.parse(raw);
    return {
      path: relativePath,
      count: Object.keys(data ?? {}).length,
      unavailable: false,
    };
  } catch {
    return { path: relativePath, count: 0, unavailable: true };
  }
}

function report(outdatedPaths) {
  const metrics = packageRoots.map(loadPackage).map(metricsFor);
  const outdated = outdatedPaths.map(parseOutdated).filter(Boolean);

  console.log('# Dependency audit metrics');
  console.log('');
  console.log(
    '| Package root | Locked packages | Direct deps | Direct dev deps | Unknown licenses | GPL/AGPL alerts |',
  );
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |');

  for (const item of metrics) {
    console.log(
      `| ${item.label} | ${item.totalPackages} | ${item.directDependencies} | ${item.directDevDependencies} | ${item.unknownLicense} | ${item.strongCopyleft.length} |`,
    );
  }

  const alerts = metrics.flatMap((item) =>
    item.strongCopyleft.map((entry) => `${item.label}: ${entry}`),
  );

  console.log('');
  if (alerts.length === 0) {
    console.log('No GPL/AGPL licenses were reported by npm lockfile metadata.');
  } else {
    console.log('> [!WARNING]');
    console.log(
      '> GPL/AGPL license metadata was detected. This is informational and does not fail CI:',
    );
    for (const alert of alerts) console.log(`> - ${alert}`);
  }

  if (outdated.length > 0) {
    console.log('');
    console.log('## Outdated dependency scan');
    for (const item of outdated) {
      const status = item.unavailable
        ? 'scan unavailable'
        : `${item.count} package(s) reported`;
      console.log(`- ${item.path}: ${status}`);
    }
  }
}

const command = process.argv[2] ?? 'validate';

if (command === 'validate') {
  validate();
} else if (command === 'report') {
  report(process.argv.slice(3));
} else {
  console.error(`Unknown command: ${command}`);
  console.error(
    'Usage: node scripts/dependency-audit.cjs <validate|report> [outdated-json ...]',
  );
  process.exitCode = 2;
}
