#!/usr/bin/env node
'use strict';

// Reject newly added untyped JavaScript within the backend source tree.
// Existing JS is deliberately governed by the documented migration backlog.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const base = process.env.JSDOC_BASE_SHA;
if (!base || !/^[0-9a-f]{40}$/.test(base)) {
  console.error('JSDOC_BASE_SHA must be a verified 40-character PR base commit.');
  process.exit(2);
}
let changed;
try {
  changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', '-z', base, 'HEAD'], { encoding: 'utf8' });
} catch (error) {
  console.error('Could not compare against the pull-request base:', error.message);
  process.exit(2);
}
const untyped = [];
for (const filepath of changed.split('\0').filter(Boolean)) {
  if (!/^backend\/src\/.*\.js$/.test(filepath)) continue;
  const source = fs.readFileSync(filepath, 'utf8');
  // A file-level typed JSDoc annotation; decorative prose /**...*/ isn't sufficient.
  if (!/\/\*\*[\s\S]*?@(typedef|type|param|returns?|template|implements)\b/.test(source)) {
    untyped.push(filepath);
  }
}
if (untyped.length) {
  console.error('New backend JavaScript requires typed JSDoc (see docs/typescript-migration.md):');
  for (const filepath of untyped) console.error('  ' + filepath);
  process.exitCode = 1;
} else {
  console.log('New backend JavaScript JSDoc policy satisfied.');
}
