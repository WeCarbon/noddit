import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import {
  CLAUDE_MANUAL_LINES,
  CLAUDE_MARKETPLACE,
  CLAUDE_PLUGIN,
  OLD_CLAUDE_MANUAL_LINES,
  OLD_CLAUDE_PLUGIN,
  agentsMdPath,
  commandExists,
  detectAgents,
  rulesBody,
  setupAgent,
  setupClaudePlugin,
  setupViaAgentsMd,
  upsertSection,
} from '../src/core/agents.ts'
import { decs, decsResult, scratch } from './helpers.ts'

/** A temp PATH entry with a given set of fake, empty, executable "binaries" — never the real claude/codex/kimi. */
function fakeBinDir(names: string[]): string {
  const dir = scratch()
  for (const name of names) {
    const path = join(dir, name)
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    chmodSync(path, 0o755)
  }
  return dir
}

// ---------------------------------------------------------------------------
// detection — never the real PATH
// ---------------------------------------------------------------------------

test('commandExists finds a name only on the given PATH, never falling back to the real one', (t) => {
  const dir = fakeBinDir(['codex'])
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(commandExists('codex', dir), true)
  assert.equal(commandExists('claude', dir), false)
  assert.equal(commandExists('codex', ''), false)
})

test('detectAgents reports each of claude/codex/kimi independently', (t) => {
  const dir = fakeBinDir(['codex', 'kimi'])
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(detectAgents(dir), { claude: false, codex: true, kimi: true })
  assert.deepEqual(detectAgents(''), { claude: false, codex: false, kimi: false })
})

// ---------------------------------------------------------------------------
// rulesBody — the same text the plugin injects, English in every language
// ---------------------------------------------------------------------------

test('rulesBody is plugin/rules.md, the one English rules file', () => {
  const body = rulesBody()
  assert.ok(body.startsWith('## nod:'))
  assert.match(body, /nod <command> --help/)
})

const RULES_TARGET = 3500
const RULES_LIMIT = 5000

test(`the injected rules stay short: under ${RULES_LIMIT} characters (aim for ${RULES_TARGET}) — the commands teach the rest`, () => {
  const length = [...rulesBody()].length
  assert.ok(length <= RULES_LIMIT, `plugin/rules.md is ${length} characters; move what a command's output, --help or the nod skill can teach out of it`)
})

// ---------------------------------------------------------------------------
// upsertSection — the marker block, never touching anything else
// ---------------------------------------------------------------------------

test('upsertSection creates a file that does not exist yet', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'AGENTS.md')
  const r = upsertSection(path, 'the decs rules go here')
  assert.equal(r.action, 'created')
  const text = readFileSync(path, 'utf8')
  assert.match(text, /<!-- decs:start/)
  assert.match(text, /the decs rules go here/)
  assert.match(text, /<!-- decs:end -->/)
})

test('upsertSection appends after existing content without touching it', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'AGENTS.md')
  writeFileSync(path, '# My project\n\nSome rules a person wrote by hand.\n')
  const r = upsertSection(path, 'decs rules v1')
  assert.equal(r.action, 'updated')
  const text = readFileSync(path, 'utf8')
  assert.match(text, /# My project/)
  assert.match(text, /Some rules a person wrote by hand\./)
  assert.match(text, /decs rules v1/)
})

test('upsertSection run twice with the same body is a no-op the second time', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'AGENTS.md')
  upsertSection(path, 'decs rules v1')
  const before = readFileSync(path, 'utf8')
  const r = upsertSection(path, 'decs rules v1')
  assert.equal(r.action, 'unchanged')
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('upsertSection replaces only its own block when the body changes, keeping content around it', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'AGENTS.md')
  writeFileSync(path, '# Before\n\nhand-written\n\n')
  upsertSection(path, 'decs rules v1')
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n# After\n\nmore hand-written\n`)
  const r = upsertSection(path, 'decs rules v2')
  assert.equal(r.action, 'updated')
  const text = readFileSync(path, 'utf8')
  assert.match(text, /# Before/)
  assert.match(text, /hand-written/)
  assert.match(text, /# After/)
  assert.match(text, /more hand-written/)
  assert.match(text, /decs rules v2/)
  assert.doesNotMatch(text, /decs rules v1/)
})

test('upsertSection with dryRun reports the action but writes nothing', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'AGENTS.md')
  const r = upsertSection(path, 'decs rules', { dryRun: true })
  assert.equal(r.action, 'created')
  assert.equal(existsSync(path), false)
})

// ---------------------------------------------------------------------------
// setupViaAgentsMd / setupAgent — codex and kimi share one file
// ---------------------------------------------------------------------------

test('codex and kimi write the same AGENTS.md section; the second one is unchanged', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const codex = setupViaAgentsMd(dir, 'en')
  assert.equal(codex.action, 'created')
  assert.equal(codex.file, agentsMdPath(dir))
  const kimi = setupViaAgentsMd(dir, 'en')
  assert.equal(kimi.action, 'unchanged')
})

test('setupAgent skips an agent that is not on the given PATH', (t) => {
  const dir = scratch()
  const bin = fakeBinDir([])
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })
  const r = setupAgent('codex', dir, 'en', { pathEnv: bin })
  assert.deepEqual(r, { detected: false, action: 'skipped', detail: 'codex not found on PATH' })
})

test('setupAgent writes AGENTS.md for codex once it is on PATH', (t) => {
  const dir = scratch()
  const bin = fakeBinDir(['codex'])
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })
  const r = setupAgent('codex', dir, 'en', { pathEnv: bin })
  assert.equal(r.detected, true)
  assert.equal(r.action, 'created')
  assert.equal(r.file, agentsMdPath(dir))
})

// ---------------------------------------------------------------------------
// setupClaudePlugin — a fake `exec`, never the real `claude` binary
// ---------------------------------------------------------------------------

test('setupClaudePlugin dry-run never calls exec and reports the manual lines', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let called = false
  const r = setupClaudePlugin(dir, { dryRun: true, exec: () => ((called = true), { status: 0, stdout: '', stderr: '' }) })
  assert.equal(called, false)
  assert.equal(r.action, 'manual')
  assert.equal(r.detail, CLAUDE_MANUAL_LINES.join('\n'))
})

test('setupClaudePlugin reports created once marketplace add and install both succeed', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const calls: string[][] = []
  const r = setupClaudePlugin(dir, {
    exec: (args) => {
      calls.push(args)
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(r.action, 'created')
  assert.ok(r.detail.includes(CLAUDE_PLUGIN))
  assert.ok(r.detail.includes(CLAUDE_MARKETPLACE))
  assert.deepEqual(calls[0], ['plugin', 'list', '--json'], 'checks for an old decs@decisions-md install first')
  assert.deepEqual(calls[1], ['plugin', 'marketplace', 'add', CLAUDE_MARKETPLACE, '--scope', 'project'])
  assert.deepEqual(calls[2], ['plugin', 'install', CLAUDE_PLUGIN, '--scope', 'project', '--json', '-y'])
})

test('setupClaudePlugin reports unchanged when the plugin is already installed', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // marketplace add succeeds; install reports "already installed" instead of actually installing.
  const r = setupClaudePlugin(dir, {
    exec: (args) => (args[1] === 'install' ? { status: 0, stdout: 'already installed', stderr: '' } : { status: 0, stdout: '', stderr: '' }),
  })
  assert.equal(r.action, 'unchanged')
})

test('setupClaudePlugin falls back to manual when marketplace add fails outright', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = setupClaudePlugin(dir, {
    exec: (args) => (args[1] === 'marketplace' ? { status: 1, stdout: '', stderr: 'network error' } : { status: 0, stdout: '', stderr: '' }),
  })
  assert.equal(r.action, 'manual')
  assert.equal(r.detail, CLAUDE_MANUAL_LINES.join('\n'))
})

test('setupClaudePlugin falls back to manual when install fails', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = setupClaudePlugin(dir, {
    exec: (args) => (args[0] === 'plugin' && args[1] === 'install' ? { status: 1, stdout: '', stderr: 'boom' } : { status: 0, stdout: '', stderr: '' }),
  })
  assert.equal(r.action, 'manual')
})

test('setupClaudePlugin treats "marketplace already exists" as success, not a failure', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = setupClaudePlugin(dir, {
    exec: (args) => (args[1] === 'marketplace' ? { status: 1, stdout: '', stderr: 'marketplace already added' } : { status: 0, stdout: '', stderr: '' }),
  })
  assert.equal(r.action, 'created')
})

// ---------------------------------------------------------------------------
// An older decs@decisions-md install: remove it non-interactively, then
// install nod@noddit in its place.
// ---------------------------------------------------------------------------

test('setupClaudePlugin finds an old decs@decisions-md install, removes it, and installs nod@noddit', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const calls: string[][] = []
  const r = setupClaudePlugin(dir, {
    exec: (args) => {
      calls.push(args)
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ id: OLD_CLAUDE_PLUGIN, scope: 'user' }]), stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(r.action, 'updated', 'migrating an existing install is reported as updated, not created')
  assert.ok(r.detail.includes(CLAUDE_PLUGIN))
  assert.ok(r.detail.includes(OLD_CLAUDE_PLUGIN), 'detail says the old plugin was removed')
  assert.deepEqual(calls[0], ['plugin', 'list', '--json'])
  assert.deepEqual(calls[1], ['plugin', 'uninstall', OLD_CLAUDE_PLUGIN, '--scope', 'user', '-y'], 'uninstalls from the scope it was actually found in')
  assert.deepEqual(calls[2], ['plugin', 'marketplace', 'add', CLAUDE_MARKETPLACE, '--scope', 'project'])
  assert.deepEqual(calls[3], ['plugin', 'install', CLAUDE_PLUGIN, '--scope', 'project', '--json', '-y'])
})

test('setupClaudePlugin falls back to manual (uninstall then install lines) when the old plugin cannot be removed non-interactively', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = setupClaudePlugin(dir, {
    exec: (args) => {
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ id: OLD_CLAUDE_PLUGIN, scope: 'user' }]), stderr: '' }
      if (args[1] === 'uninstall') return { status: 1, stdout: '', stderr: 'permission denied' }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(r.action, 'manual')
  assert.equal(r.detail, OLD_CLAUDE_MANUAL_LINES.join('\n'))
  assert.ok(r.detail.includes(`uninstall ${OLD_CLAUDE_PLUGIN}`))
  assert.ok(r.detail.includes(CLAUDE_PLUGIN))
})

test('setupClaudePlugin proceeds normally when no old plugin is installed', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const calls: string[][] = []
  const r = setupClaudePlugin(dir, {
    exec: (args) => {
      calls.push(args)
      if (args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ id: 'frontend-design@claude-plugins-official', scope: 'user' }]), stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
  })
  assert.equal(r.action, 'created')
  assert.ok(calls.every((c) => c[0] !== 'plugin' || c[1] !== 'uninstall'), 'never uninstalls anything when the old plugin is not present')
})

test('setupClaudePlugin treats an unreadable `plugin list` as no old install, rather than failing', (t) => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = setupClaudePlugin(dir, {
    exec: (args) => (args[1] === 'list' ? { status: 1, stdout: '', stderr: 'boom' } : { status: 0, stdout: '', stderr: '' }),
  })
  assert.equal(r.action, 'created')
})

// ---------------------------------------------------------------------------
// The CLI command end to end — restricted PATH, real temp project dir
// ---------------------------------------------------------------------------

test('decs setup --json: claude skipped (not on PATH), codex creates AGENTS.md, kimi finds it unchanged', (t) => {
  const project = scratch()
  const bin = fakeBinDir(['codex', 'kimi'])
  t.after(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })
  const out = decs(project, ['setup', '--dir', project, '--json'], { PATH: bin })
  const parsed = JSON.parse(out)
  assert.equal(parsed.dir, project)
  assert.equal(parsed.dryRun, false)
  assert.equal(parsed.agents.claude.detected, false)
  assert.equal(parsed.agents.claude.action, 'skipped')
  assert.equal(parsed.agents.codex.action, 'created')
  assert.equal(parsed.agents.kimi.action, 'unchanged')
  assert.equal(parsed.agents.codex.file, parsed.agents.kimi.file)
  assert.ok(readFileSync(join(project, 'AGENTS.md'), 'utf8').includes('decs:start'))
})

test('decs setup --for codex --dry-run writes nothing', (t) => {
  const project = scratch()
  const bin = fakeBinDir(['codex'])
  t.after(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })
  const out = decs(project, ['setup', '--dir', project, '--for', 'codex', '--dry-run', '--json'], { PATH: bin })
  const parsed = JSON.parse(out)
  assert.equal(parsed.dryRun, true)
  assert.equal(Object.keys(parsed.agents).length, 1)
  assert.equal(parsed.agents.codex.action, 'created')
  assert.equal(existsSync(join(project, 'AGENTS.md')), false)
})

test('decs setup --for kimi,codex limits to the given agents, comma-separated', (t) => {
  const project = scratch()
  const bin = fakeBinDir(['codex', 'kimi'])
  t.after(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })
  const out = decs(project, ['setup', '--dir', project, '--for', 'kimi,codex', '--json'], { PATH: bin })
  const parsed = JSON.parse(out)
  assert.deepEqual(new Set(Object.keys(parsed.agents)), new Set(['kimi', 'codex']))
})

test('decs setup --for bogus is a clear error, not a silent no-op', (t) => {
  const project = scratch()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const r = decsResult(project, ['setup', '--dir', project, '--for', 'bogus'], { PATH: '' })
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /bogus/)
})

test('decs setup is idempotent on a second run: second pass reports unchanged', (t) => {
  const project = scratch()
  const bin = fakeBinDir(['codex'])
  t.after(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })
  decs(project, ['setup', '--dir', project, '--for', 'codex', '--json'], { PATH: bin })
  const second = JSON.parse(decs(project, ['setup', '--dir', project, '--for', 'codex', '--json'], { PATH: bin }))
  assert.equal(second.agents.codex.action, 'unchanged')
})

test('decs setup never touches content above or below its block in an existing AGENTS.md', (t) => {
  const project = scratch()
  const bin = fakeBinDir(['codex'])
  t.after(() => {
    rmSync(project, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  })
  writeFileSync(join(project, 'AGENTS.md'), '# Hand-written project notes\n\nDo not remove this line.\n')
  decs(project, ['setup', '--dir', project, '--for', 'codex', '--json'], { PATH: bin })
  const text = readFileSync(join(project, 'AGENTS.md'), 'utf8')
  assert.match(text, /# Hand-written project notes/)
  assert.match(text, /Do not remove this line\./)
  assert.match(text, /decs:start/)
})

test('decs setup --help mentions --for, --dir, --dry-run and --json', (t) => {
  const project = scratch()
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const out = decs(project, ['setup', '--help'])
  assert.match(out, /--for/)
  assert.match(out, /--dir/)
  assert.match(out, /--dry-run/)
  assert.match(out, /--json/)
})
