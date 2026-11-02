#!/usr/bin/env node
// Cross-platform equivalent of scripts/release.sh (no bash/perl — useful on Windows without
// WSL/Git Bash). Same steps: bump every version, run the gate, commit, tag. Does not push.
//
//   node scripts/release.mjs 1.2.3

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
}

function capture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', ...opts });
}

function bumpToml(relPath, version) {
  const p = join(repoRoot, relPath);
  const text = readFileSync(p, 'utf8');
  const next = text.replace(/^version\s*=\s*"[^"]*"/m, `version = "${version}"`);
  if (next === text && !new RegExp(`^version\\s*=\\s*"${version}"`, 'm').test(text)) {
    throw new Error(`no top-level version = "..." line found in ${relPath}`);
  }
  writeFileSync(p, next);
}

function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('usage: node scripts/release.mjs <version>   (e.g. node scripts/release.mjs 1.2.3)');
    process.exit(2);
  }
  const version = raw.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`version must be X.Y.Z (got: ${raw})`);
    process.exit(2);
  }

  const status = capture('git', ['status', '--porcelain']).trim();
  if (status) {
    console.error('Working tree is not clean. Commit or stash first.');
    process.exit(1);
  }

  console.log(`Bumping to ${version} ...`);
  run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { stdio: 'ignore' });
  run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], {
    stdio: 'ignore',
    cwd: join(repoRoot, 'app'),
  });

  const tauriConfPath = join(repoRoot, 'app/src-tauri/tauri.conf.json');
  const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
  tauriConf.version = version;
  writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');

  bumpToml('app/src-tauri/Cargo.toml', version);
  bumpToml('python/pyproject.toml', version);

  try {
    capture('cargo', ['check', '--offline', '--quiet'], { cwd: join(repoRoot, 'app/src-tauri') });
  } catch {
    console.error("note: couldn't refresh app/src-tauri/Cargo.lock locally; CI will do it on build.");
  }

  run('node', ['scripts/check-version.mjs', version]);

  console.log('Running the gate ...');
  run('npm', ['test']);
  run('npm', ['run', 'typecheck']);

  console.log('Committing ...');
  run('git', [
    'add',
    'package.json',
    'package-lock.json',
    'app/package.json',
    'app/package-lock.json',
    'app/src-tauri/tauri.conf.json',
    'app/src-tauri/Cargo.toml',
    'app/src-tauri/Cargo.lock',
    'python/pyproject.toml',
  ]);
  run('git', ['commit', '-m', `release v${version}`]);
  run('git', ['tag', `v${version}`]);

  console.log(`\nDone. Tagged v${version} locally. To publish:\n\n  git push origin main v${version}\n`);
}

main();
