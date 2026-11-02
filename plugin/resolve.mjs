// Node refuses to strip types from a .ts file whose path runs through
// node_modules — fine for a repo checkout (bin/decs.ts runs directly), but
// not once this package is installed as a dependency. Hooks and monitors
// need one module that picks the right file either way: the compiled
// dist/*.js when this is an npm install, the .ts source next to it when
// it's a repo checkout.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// A git checkout runs its .ts source even if a publish left a dist/ behind;
// only an installed package (no .git) uses the compiled files.
const HAS_DIST = existsSync(join(ROOT, 'dist')) && !existsSync(join(ROOT, '.git'))

/** Filesystem path to a repo-relative `.ts` file, resolved to its compiled
 *  dist/*.js counterpart when `dist/` exists. */
export function modulePath(...tsParts) {
  return HAS_DIST ? join(ROOT, 'dist', ...tsParts).replace(/\.ts$/, '.js') : join(ROOT, ...tsParts)
}

/** Same resolution as `modulePath`, as a `file://` URL dynamic `import()` can use. */
export function moduleUrl(...tsParts) {
  return pathToFileURL(modulePath(...tsParts)).href
}
