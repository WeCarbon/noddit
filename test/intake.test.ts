import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { briefTitle, withDescription } from '../src/core/intake.ts'
import { asQuote, launchPlan, shQuote, type LaunchEnv } from '../src/core/launch.ts'
import { initLayout } from '../src/core/paths.ts'
import { Store } from '../src/core/store.ts'
import { glyphOf, suffixOf } from '../src/tui/views.ts'
import { BIN, decs, decsResult, killAndWait, scratch } from './helpers.ts'

/** The owner's own terminal: no CLAUDECODE, no DECS_AUTHOR. */
const OWNER = { CLAUDECODE: undefined, DECS_AUTHOR: undefined }

/** Retries past a lingering lock on Windows — a just-killed or detached child (the
 *  $NODDIT_BRIEF_CMD hook) can hold `root` as its cwd, or hold a file inside it open,
 *  a few seconds longer than the test ever sees it running. Generous and explicit
 *  rather than relying on fs.rmSync's own built-in (and less predictable) backoff. */
async function rmScratch(dir: string, ms = 10_000): Promise<void> {
  for (const deadline = Date.now() + ms; ; ) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (Date.now() > deadline || (code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EPERM')) throw e
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

function project(t: { after: (fn: () => void) => void }) {
  const root = scratch()
  const home = join(root, '.home')
  t.after(() => rmScratch(root))
  decs(root, ['init', '--no-register'])
  const run = (args: string[], env: Record<string, string | undefined> = {}, input = '') => decs(root, args, { DECS_HOME: home, ...env }, input)
  const result = (args: string[], env: Record<string, string | undefined> = {}) => decsResult(root, args, { DECS_HOME: home, ...env })
  const json = (args: string[], env: Record<string, string | undefined> = {}) => JSON.parse(run([...args, '--json'], env))
  return { root, home, run, result, json }
}

async function waitFor(ok: () => boolean, what: string, ms = 15_000): Promise<void> {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    if (ok()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.fail(`timed out waiting for ${what}`)
}

const settle = () => new Promise((r) => setTimeout(r, 800))

test("a bare nod add from the owner's terminal is a brief: owner-signed, words kept verbatim under 原话", (t) => {
  const p = project(t)
  const words = 'make onboarding faster for people who sign up on their phone'
  const d = p.json(['add', words], OWNER)
  assert.equal(d.author, 'owner')
  assert.equal(d.status, 'not_started')
  assert.equal(d.kind, 'task')
  assert.equal(d.intake, true)
  assert.equal(d.brief, 'unclaimed')
  assert.equal(d.original, words)
  assert.equal(d.title, briefTitle(words), 'a long line is cut to a title; the full text stays under 原话')
  assert.ok(d.title.endsWith('…'))
  assert.equal(d.listening, false)
  assert.equal(d.hook, 'unset')
  const file = readFileSync(d.file, 'utf8')
  assert.match(file, /^intake: true$/m)
  assert.match(file, /^## 原话（human · owner · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}）\n\nmake onboarding faster for people who sign up on their phone\n$/m)
})

test('briefs: --brief from an agent, opting out, and what is never a brief', (t) => {
  const p = project(t)
  assert.equal(p.json(['add', 'ship it'], OWNER).intake, true)
  assert.equal(p.json(['add', 'ship it', '--no-brief', '--author', 'owner'], OWNER).intake, false)
  assert.equal(p.json(['add', 'ship it', '--task', '--author', 'owner'], OWNER).intake, false)
  assert.equal(p.json(['add', 'ship it', '-o', '1=yes', '2=no', '--author', 'owner'], OWNER).intake, false)
  assert.equal(p.json(['add', 'ship it']).intake, false, 'an agent shell keeps the old meaning')
  const relayed = p.json(['add', 'tidy the docs', '--brief', '--author', 'owner'])
  assert.equal(relayed.intake, true)
  assert.equal(relayed.notes[0].role, 'human', 'relayed as the owner, the 原话 reads as the owner’s')
  const r = p.result(['add', 'x', '--brief', '-o', '1=a', '2=b'])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /--brief/)
})

test('nod claim is atomic: exactly one of several racing sessions gets the brief, the rest are told who has it', async (t) => {
  const p = project(t)
  p.run(['add', 'fix login'], OWNER)
  const racers = ['lane-a', 'lane-b', 'lane-c', 'lane-d']
  const results = await Promise.all(
    racers.map(
      (name) =>
        new Promise<{ code: number; out: string; err: string }>((resolve) => {
          const c = spawn(process.execPath, [BIN, 'claim', '1', '--json'], {
            cwd: p.root,
            env: { ...process.env, NO_COLOR: '1', DECS_LANG: 'en', CLAUDECODE: '1', DECS_AUTHOR: `${name} · racing`, DECS_HOME: p.home },
          })
          let out = ''
          let err = ''
          c.stdout.on('data', (b) => (out += b))
          c.stderr.on('data', (b) => (err += b))
          c.on('exit', (code) => resolve({ code: code ?? -1, out, err }))
        }),
    ),
  )
  const won = results.filter((r) => r.code === 0)
  assert.equal(won.length, 1, JSON.stringify(results))
  const winner = JSON.parse(won[0].out)
  assert.equal(winner.ok, true)
  for (const lost of results.filter((r) => r.code !== 0)) {
    const j = JSON.parse(lost.out)
    assert.equal(j.ok, false)
    assert.equal(j.claimed_by, winner.claimed_by)
    assert.match(lost.err, new RegExp(`already picked up by ${winner.claimed_by.split(' · ')[0]}`))
  }
  const node = p.json(['get', '1'])
  assert.equal(node.status, 'in_progress')
  assert.equal(node.owner_agent, winner.claimed_by)
  assert.equal(node.brief, 'claimed')
  assert.equal(node.notes.filter((n: { kind: string }) => n.kind === '接活').length, 1)
  // Claiming again yourself changes nothing.
  const again = p.json(['claim', '1'], { DECS_AUTHOR: winner.claimed_by })
  assert.equal(again.already, true)
})

test("nod claim refuses an agent's own node unless --force; nod start on a brief claims it", (t) => {
  const p = project(t)
  p.run(['add', 'a lane task', '--task'], { DECS_AUTHOR: 'lane-x · work' })
  const r = p.result(['claim', '1'], { DECS_AUTHOR: 'lane-y · other' })
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /not a brief/)
  p.run(['add', 'speed up the build'], OWNER)
  p.run(['start', '2'], { DECS_AUTHOR: 'lane-y · build' })
  assert.equal(p.json(['get', '2']).claimed_by, 'lane-y · build')
  const late = p.result(['start', '2'], { DECS_AUTHOR: 'lane-z · late' })
  assert.notEqual(late.code, 0)
  assert.match(late.stderr, /already picked up by lane-y/)
})

test('nod expand rewrites the description above 原话 and keeps every note; only the claimer may', (t) => {
  const p = project(t)
  p.run(['add', 'fix login'], OWNER)
  const me = { DECS_AUTHOR: 'lane-a · login' }
  const body = '**What.** Login fails on a mobile browser.\n\n**Done when.** A test covers it. *(Assumption: desktop is fine.)*'
  const expanded = JSON.parse(p.run(['expand', '1', '--title', 'Fix the mobile login', '--json'], me, body))
  assert.equal(expanded.title, 'Fix the mobile login')
  assert.equal(expanded.claimed_by, 'lane-a · login', 'expanding an unclaimed brief claims it')
  assert.equal(expanded.original, 'fix login')
  assert.ok(expanded.body.trimStart().startsWith('**What.** Login fails'))
  assert.ok(expanded.body.indexOf('## 原话') > expanded.body.indexOf('Done when'))
  // A second expand replaces the description again, not the owner's words.
  p.run(['expand', '1'], me, 'Second take.')
  const twice = p.json(['get', '1'])
  assert.ok(twice.body.trimStart().startsWith('Second take.'))
  assert.ok(!twice.body.includes('Login fails'))
  assert.equal(twice.original, 'fix login')
  const other = p.result(['expand', '1'], { DECS_AUTHOR: 'lane-b · other' })
  assert.notEqual(other.code, 0)

  // The claimer asks the owner on the brief without --force, and its --mine queue sees the answer.
  p.run(['add', 'Reproduce it', '--task', '--parent', '1', '--est', '15m'], me)
  p.run(['ask', '1', '-o', '1=start as planned', '2=change it'], me)
  p.run(['push', '1', '1'], OWNER)
  assert.match(p.run(['queue', '--mine'], me), /X1/)
})

test('withDescription moves a hand-written node’s old description under 原话 first', () => {
  const body = 'Make the docs nicer.\n\n## 补充（agent · lane · 2026-10-01 09:00:00）\n\nnote\n'
  const out = withDescription(body, 'Full plan.', '原话（human · owner · 2026-10-01 08:00:00）')
  assert.equal(out, 'Full plan.\n\n## 原话（human · owner · 2026-10-01 08:00:00）\n\nMake the docs nicer.\n\n## 补充（agent · lane · 2026-10-01 09:00:00）\n\nnote\n')
})

test('nod expand on an owner-written plain node: claim it first, nothing is lost', (t) => {
  const p = project(t)
  p.run(['add', 'docs pass', '--task', '--author', 'owner'], OWNER, 'Make the docs nicer.')
  const me = { DECS_AUTHOR: 'lane-a · docs' }
  assert.notEqual(p.result(['expand', '1', '--body', 'Plan.'], me).code, 0, 'not yours until claimed')
  p.run(['claim', '1'], me)
  p.run(['expand', '1', '--body', 'Plan.'], me)
  const d = p.json(['get', '1'])
  assert.ok(d.body.trimStart().startsWith('Plan.\n\n## 原话（human · owner · '))
  assert.equal(d.original, 'Make the docs nicer.')
})

test('nod monitor: DECS-BRIEF for every unclaimed brief, a reminder once, a heartbeat while it runs', async (t) => {
  const p = project(t)
  p.run(['add', 'already waiting'], OWNER)
  p.run(['add', 'a lane node', '--task'], { DECS_AUTHOR: 'lane-m · mine' })
  const env = { ...process.env, NO_COLOR: '1', DECS_LANG: 'en', CLAUDECODE: '1', DECS_AUTHOR: 'lead · watch', DECS_HOME: p.home }
  const lead = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '200', '--unclaimed-after', '2s', '--no-sources'], { cwd: p.root, env })
  const mine = spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--mine', '--interval', '200', '--no-sources'], { cwd: p.root, env: { ...env, DECS_AUTHOR: 'lane-m · mine' } })
  let out = ''
  let mineOut = ''
  lead.stdout.on('data', (b) => (out += b))
  mine.stdout.on('data', (b) => (mineOut += b))
  t.after(() => killAndWait(lead))
  t.after(() => killAndWait(mine))
  await waitFor(() => out.includes('DECS-BRIEF X1'), 'the startup brief line')
  assert.match(out, /^DECS-BRIEF X1 the owner filed a brief: already waiting — nod claim X1, expand and split it, then nod ask to have the owner confirm  since=\S+$/m)

  const sessions = p.json(['sessions'])
  assert.equal(sessions.projects[0].listening, true)
  const roles = sessions.projects[0].sessions.map((s: { role: string }) => s.role).sort()
  assert.deepEqual(roles, ['lead', 'teammate'])
  assert.equal(p.json(['bench']).projects[0].listening, true)

  const filed = p.json(['add', 'new while watching'], OWNER)
  assert.equal(filed.listening, true)
  p.run(['add', 'under the lane', '--parent', '2'], OWNER)
  await waitFor(() => out.includes('DECS-BRIEF X3') && out.includes('DECS-BRIEF X4'), 'the new brief lines')
  await waitFor(() => /DECS-BRIEF X1 the owner’s brief has waited .* with nobody picking it up/.test(out), 'the reminder')
  await waitFor(() => mineOut.includes('DECS-BRIEF X4'), 'the brief under the lane’s own node')
  await settle()
  assert.ok(!mineOut.includes('DECS-BRIEF X1'), 'a --mine monitor leaves root briefs to the lead')
  assert.equal(out.match(/DECS-BRIEF X1 /g)?.length, 2, 'once when seen, once as a reminder')
  assert.ok(!/Original words|原话/.test(out), 'the 原话 section is not reported as an owner note too')

  // A claimed brief is no longer announced.
  p.run(['claim', '3'], { DECS_AUTHOR: 'lead · watch' })
  await killAndWait(lead)
  await killAndWait(mine)
  assert.equal(p.json(['sessions']).projects[0].listening, false, 'the heartbeat goes with the monitor')
})

test('nod briefs lists what waits, with whether anyone is listening', (t) => {
  const p = project(t)
  p.run(['add', 'first'], OWNER)
  p.run(['add', 'second'], OWNER)
  p.run(['claim', '2'], { DECS_AUTHOR: 'lane-a · x' })
  const j = p.json(['briefs'])
  assert.deepEqual(j.briefs.map((b: { ref: string }) => b.ref), ['X1'])
  assert.equal(j.projects[0].listening, false)
  assert.deepEqual(j.projects[0].sessions, [])
  assert.deepEqual(p.json(['briefs', '--all']).briefs.map((b: { ref: string }) => b.ref).sort(), ['X1', 'X2'])
  assert.match(p.run(['briefs']), /nobody listening/)
})

test('a brief filed with nobody listening runs $DECS_BRIEF_CMD with the brief in its environment', async (t) => {
  const p = project(t)
  const out = join(p.root, 'hook.txt')
  const d = p.json(['add', 'tidy up'], { ...OWNER, DECS_BRIEF_CMD: `node -e "require('fs').writeFileSync(process.argv[1], process.env.DECS_REF)" "${out}"` })
  assert.equal(d.hook, 'ran')
  await waitFor(() => existsSync(out) && readFileSync(out, 'utf8') === 'X1', 'the hook to run')
})

test('nod session start: refuses while a main session listens; otherwise hands its plan to the launcher', (t) => {
  const p = project(t)
  const record = join(p.root, 'launch.jsonl')
  const dry = p.json(['session', 'start', '--dry-run', '--agent', 'codex'], { NODDIT_LAUNCH_RECORD: record })
  assert.equal(dry.ok, true)
  assert.equal(dry.started, false)
  assert.equal(dry.plan.agent, 'codex')
  assert.ok(!existsSync(record), '--dry-run opens nothing')

  const real = p.json(['session', 'start'], { NODDIT_LAUNCH_RECORD: record })
  if (real.plan.exec) {
    const plans = readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(plans.length, 1)
    assert.equal(plans[0].agent, 'claude')
  }
  assert.ok(real.plan.command.includes('claude'))

  // A live lead heartbeat (this test process's own pid is alive).
  mkdirSync(join(p.home, 'sessions'), { recursive: true })
  const now = new Date().toISOString()
  writeFileSync(join(p.home, 'sessions', 'fake.json'), JSON.stringify({ pid: process.pid, roots: [p.root], author: 'lead-x · main', harness: 'claude-code', role: 'lead', started_at: now, last_seen: now }))
  const r = p.result(['session', 'start'], { NODDIT_LAUNCH_RECORD: record })
  assert.equal(r.code, 1)
  assert.match(r.stderr, /already has a session listening: lead-x · main/)
  assert.match(p.run(['sessions']), /lead-x · main/)
  // A heartbeat from a dead process doesn't count.
  writeFileSync(join(p.home, 'sessions', 'fake.json'), JSON.stringify({ pid: 999_999_9, roots: [p.root], author: 'gone', harness: null, role: 'lead', started_at: now, last_seen: now }))
  assert.equal(p.json(['sessions']).projects[0].listening, false)
  assert.equal(p.json(['add', 'x'], OWNER).listening, false)
})

test('launch plans: iTerm2, Terminal, Windows Terminal, cmd, Linux, none — with paths quoted safely', () => {
  const root = `/work/it's "here"`
  const env = (platform: NodeJS.Platform, has: string[]): LaunchEnv => ({ platform, has: (n) => has.includes(n) })

  const iterm = launchPlan('claude', root, env('darwin', ['iTerm.app']))
  assert.equal(iterm.terminal, 'iterm')
  assert.equal(iterm.command.startsWith(`cd ${shQuote(root)} && 'claude' '`), true)
  assert.ok(iterm.script!.includes(`write text ${asQuote(iterm.command)}`))
  assert.deepEqual(iterm.exec, { file: 'osascript', args: ['-e', iterm.script!] })

  const term = launchPlan('codex', root, env('darwin', []))
  assert.equal(term.terminal, 'terminal')
  assert.ok(term.script!.includes('do script'))

  assert.equal(launchPlan('claude', 'C:\\work\\web', env('win32', ['wt'])).exec!.file, 'wt')
  const cmd = launchPlan('claude', 'C:\\work\\web', env('win32', []))
  assert.equal(cmd.terminal, 'cmd')
  assert.ok(cmd.exec!.args.includes('"C:\\work\\web"'))

  assert.equal(launchPlan('kimi', root, env('linux', ['gnome-terminal'])).terminal, 'gnome-terminal')
  const none = launchPlan('kimi', root, env('linux', []))
  assert.equal(none.exec, null)
  assert.equal(none.command, `cd ${shQuote(root)} && 'kimi'`)

  assert.equal(shQuote(`it's`), `'it'\\''s'`)
  assert.equal(asQuote('a "b" \\c'), '"a \\"b\\" \\\\c"')
})

test('the bench marks an unclaimed brief with its own glyph and badge', () => {
  const root = scratch()
  try {
    const layout = initLayout(root)
    const store = new Store(layout)
    const d = store.create({ title: 'fix login', author: 'owner', body: 'fix login', task: true, intake: true })
    const items = store.all()
    const now = Date.now()
    assert.deepEqual(glyphOf(items[0], items, now), { text: '✎', color: 'blue', bold: true })
    assert.match(suffixOf(items[0], items, now).at(-1)!.map((s) => s.text).join(''), /New from you/)
    const claimed = store.claim(d, 'lane-a · x').node
    assert.equal(glyphOf(claimed, store.all(), now).text, '◐', 'once claimed it is an ordinary running task')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a window\'s --updates monitor, or one with --no-heartbeat, is not a listening session', async (t) => {
  const p = project(t)
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', DECS_LANG: 'en', DECS_HOME: p.home }
  delete env.CLAUDECODE
  const kids = [['--updates', '--json', '--all'], ['--no-heartbeat']].map((extra) => spawn(process.execPath, [BIN, 'monitor', '--with-parent', String(process.pid), '--interval', '200', '--no-sources', ...extra], { cwd: p.root, env }))
  const outs = kids.map(() => ({ s: '' }))
  kids.forEach((k, i) => k.stderr.on('data', (b) => (outs[i].s += b)))
  for (const k of kids) t.after(() => killAndWait(k))
  await waitFor(() => outs.every((o) => o.s.includes('nod monitor')), 'both monitors to start')
  await settle()
  assert.equal(p.json(['sessions']).projects[0].listening, false)
  assert.equal(p.json(['add', 'fix login'], OWNER).listening, false)
  // Dead before `project()`'s own cleanup runs — Windows won't remove a directory
  // that's still a live process's cwd.
  await Promise.all(kids.map((k) => killAndWait(k)))
})
