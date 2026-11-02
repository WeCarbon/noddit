#!/usr/bin/env bash
# Bumps the version everywhere it's recorded, runs the gate, commits, and tags locally.
# Does NOT push — it prints the push command for you to run once you're happy with it.
#
#   scripts/release.sh 1.2.3
#
# See scripts/release.mjs for a cross-platform (e.g. Windows without a POSIX shell) version
# of the same steps.
set -euo pipefail

usage() {
  echo "usage: scripts/release.sh <version>   (e.g. scripts/release.sh 1.2.3)" >&2
  exit 2
}

[ $# -eq 1 ] || usage
version="${1#v}"
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "version must be X.Y.Z (got: $1)" >&2; exit 2 ;;
esac

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean. Commit or stash first." >&2
  exit 1
fi

echo "Bumping to $version ..."
npm version "$version" --no-git-tag-version --allow-same-version >/dev/null
(cd app && npm version "$version" --no-git-tag-version --allow-same-version >/dev/null)

node -e '
  const fs = require("node:fs");
  const path = "app/src-tauri/tauri.conf.json";
  const conf = JSON.parse(fs.readFileSync(path, "utf8"));
  conf.version = process.argv[1];
  fs.writeFileSync(path, JSON.stringify(conf, null, 2) + "\n");
' "$version"

for toml in app/src-tauri/Cargo.toml python/pyproject.toml; do
  perl -0pi -e 's/^version\s*=\s*"[^"]*"/version = "'"$version"'"/m' "$toml"
done

if command -v cargo >/dev/null 2>&1; then
  # Refreshes Cargo.lock's entry for the local app crate to match. Best effort: a stale
  # lockfile entry for a path dependency isn't fatal, cargo rewrites it on the next build
  # regardless, so a missing toolchain here shouldn't block the release.
  (cd app/src-tauri && cargo check --offline --quiet) 2>/dev/null \
    || (cd app/src-tauri && cargo check --quiet) 2>/dev/null \
    || echo "note: couldn't refresh app/src-tauri/Cargo.lock locally; CI will do it on build." >&2
fi

node scripts/check-version.mjs "$version"

echo "Running the gate ..."
npm test
npm run typecheck

echo "Committing ..."
git add package.json package-lock.json \
  app/package.json app/package-lock.json \
  app/src-tauri/tauri.conf.json app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock \
  python/pyproject.toml
git commit -m "release v$version"
git tag "v$version"

cat <<EOF

Done. Tagged v$version locally. To publish:

  git push origin main v$version

EOF
