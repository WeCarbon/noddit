#!/usr/bin/env node
// Checks that every package manifest in the repo agrees on one version number.
// Used by .github/workflows/release.yml (so a tag can't publish a release built from
// manifests it doesn't match) and by scripts/release.sh / scripts/release.mjs after they
// bump the version. No dependencies — this has to run with a bare `node`, before `npm ci`.
//
// Usage: node scripts/check-version.mjs <expected-version>   (no leading "v")

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJsonVersion(relPath) {
  const text = readFileSync(join(repoRoot, relPath), 'utf8');
  return JSON.parse(text).version;
}

// Cargo.toml / pyproject.toml: the first top-level `version = "..."` line. Both files only
// have one such line outside an inline table (dependency specs write `{ version = "...", ... }`
// on one line, which doesn't start with "version").
function readTomlVersion(relPath) {
  const text = readFileSync(join(repoRoot, relPath), 'utf8');
  const match = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error(`no top-level version = "..." line found in ${relPath}`);
  return match[1];
}

function main() {
  const expected = process.argv[2];
  if (!expected) {
    console.error('usage: node scripts/check-version.mjs <expected-version>');
    process.exit(2);
  }
  if (!/^\d+\.\d+\.\d+/.test(expected)) {
    console.error(`expected version looks wrong: "${expected}" (want X.Y.Z, no leading "v")`);
    process.exit(2);
  }

  const checks = [
    ['package.json', readJsonVersion],
    ['app/src-tauri/tauri.conf.json', readJsonVersion],
    ['app/src-tauri/Cargo.toml', readTomlVersion],
    ['python/pyproject.toml', readTomlVersion],
  ];

  const mismatches = [];
  for (const [relPath, read] of checks) {
    let actual;
    try {
      actual = read(relPath);
    } catch (err) {
      mismatches.push(`${relPath}: could not read a version (${err.message})`);
      continue;
    }
    if (actual !== expected) {
      mismatches.push(`${relPath}: ${actual}`);
    }
  }

  if (mismatches.length > 0) {
    console.error(`Version mismatch: expected ${expected}, but found:`);
    for (const line of mismatches) console.error(`  - ${line}`);
    console.error('\nRun scripts/release.sh (or scripts/release.mjs) to bump every manifest together.');
    process.exit(1);
  }

  console.log(`OK: every manifest is at ${expected}`);
}

main();
