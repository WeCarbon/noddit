// Usage: node scripts/render-screenshot.ts [--lang en|zh-Hans|zh-Hant|fr|ar] [--view available|active|decide|all] [--cols 140] [--rows 36] [--out docs/screenshot.<lang>]
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeLang } from '../src/i18n/index.ts'
import { SCENARIOS } from './screenshot-scenario.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const BIN = join(repo, 'bin', 'nod.ts')

const argv = process.argv.slice(2)
const flag = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const VIEW = flag('view', 'available')
const COLS = Number(flag('cols', '140'))
const ROWS = Number(flag('rows', '36'))
const LANG = normalizeLang(flag('lang', 'en'))
if (!LANG) throw new Error(`--lang: unknown language "${flag('lang', '')}"`)
const OUT = resolve(repo, flag('out', `docs/screenshot.${LANG}`))

const tmp = mkdtempSync(join(tmpdir(), 'decs-shot-'))
// Must be set before the dynamic imports below: config reads NODDIT_HOME at load time.
process.env.NODDIT_HOME = join(tmp, 'home')
process.env.NODDIT_LANG = LANG
// The frame is what a strictly left-to-right terminal gets: Arabic already in visual order.
process.env.NODDIT_BIDI = 'visual'

function decs(cwd: string, args: string[], opts: { input?: string; human?: boolean; author?: string } = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', NODDIT_AUTHOR: opts.author ?? 'lead · release', NODDIT_HOME: process.env.NODDIT_HOME, NODDIT_LANG: LANG }
  delete env.CLAUDECODE
  delete env.CLAUDE_SESSION_ID
  env.NODDIT_ROLE = opts.human ? 'human' : 'agent'
  // The scenario has the lead moving nodes its lanes filed; skip the other-author check.
  if (['start', 'done', 'close', 'hold', 'ask'].includes(args[0]) && !args.includes('--force')) args = [...args, '--force']
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input: opts.input ?? '', encoding: 'utf8', env })
  if (r.status !== 0) throw new Error(`decs ${args.join(' ')}\n${r.stdout}${r.stderr}`)
  return r.stdout
}
const idOf = (out: string) => Number(/[A-Z](\d+)/.exec(out)?.[1] ?? NaN)

function project(name: string, letter: string): string {
  const root = join(tmp, name)
  mkdirSync(root, { recursive: true })
  decs(root, ['init'])
  decs(root, ['config', 'letter', letter])
  return root
}

const web = project('web', 'W')
const api = project('api', 'A')

const S = SCENARIOS[LANG]

const ship = idOf(decs(web, ['add', S.ship.title, '--task', '--author', S.ship.author], { input: `${S.ship.body}\n` }))
decs(web, ['start', `${ship}`])
decs(web, ['steps', `${ship}`, ...S.ship.steps])
decs(web, ['step', `${ship}`, '1'])

const merge = idOf(decs(web, ['add', S.merge.title, '--task', '--parent', `${ship}`, '--author', S.merge.author]))
decs(web, ['start', `${merge}`])
decs(web, ['done', `${merge}`, '--note', S.merge.note])

const suite = idOf(decs(web, ['add', S.suite.title, '--task', '--parent', `${ship}`, '--after', `${merge}`, '--author', S.suite.author]))
decs(web, ['start', `${suite}`])
decs(web, ['progress', '--node', `${suite}`, '62', S.suite.progress])

decs(web, ['add', S.changelog.title, '--task', '--parent', `${ship}`, '--after', `${suite}`, '--author', S.changelog.author])

const [c1, c2, c3] = S.copy.options
const copy = idOf(
  decs(
    web,
    [
      'add', S.copy.title, '--parent', `${ship}`, '--author', S.copy.author,
      '-o', `1=${c1}`, `2=${c2}`, `3=${c3}`,
      '--default', '2', '--urgency', 'high', '--reversible', 'yes', '--if-no-answer', S.copy.ifNoAnswer,
    ],
    { input: S.copy.body(S.optionsHeading) },
  ),
)

const cdn = idOf(decs(web, ['add', S.cdn.title, '--author', S.cdn.author, '-o', `1=${S.cdn.options[0]}`, `2=${S.cdn.options[1]}`, '--default', '1'], { input: `${S.cdn.body}\n` }))
decs(web, ['push', `${cdn}`, '2', '--note', S.cdn.answer], { human: true })

const dark = idOf(decs(web, ['add', S.dark.title, '--task', '--author', S.dark.author]))
decs(web, ['start', `${dark}`])
decs(web, ['hold', `${dark}`, '--on', S.dark.on])

const billing = idOf(decs(api, ['add', S.billing.title, '--task', '--author', S.billing.author]))
decs(api, ['start', `${billing}`])
decs(api, ['steps', `${billing}`, ...S.billing.steps])
decs(api, ['step', `${billing}`, '2'])

const dual = idOf(decs(api, ['add', S.dual.title, '--task', '--parent', `${billing}`, '--author', S.dual.author]))
decs(api, ['start', `${dual}`])
decs(api, ['progress', '--node', `${dual}`, '40', S.dual.progress])

decs(api, ['add', S.backfill.title, '--task', '--parent', `${billing}`, '--after', `${dual}`, '--author', S.backfill.author])

decs(api, ['add', S.cutover.title, '--parent', `${billing}`, '--author', S.cutover.author, '-o', `1=${S.cutover.options[0]}`, `2=${S.cutover.options[1]}`, '--default', '1'], { input: `${S.cutover.body}\n` })

const keys = idOf(decs(api, ['add', S.keys.title, '--task', '--author', S.keys.author]))
decs(api, ['start', `${keys}`])
decs(api, ['done', `${keys}`, '--note', S.keys.note])

decs(web, ['source', 'register', 'github-issues', '--title', S.issues.title, '--kind', 'github', '--stale-after', '1h'])
decs(web, ['source', 'sync', 'github-issues'], {
  input: ['412', '415', '418', '420'].map((id, i) => JSON.stringify({ id, title: S.issues.items[i], state: 'open' })).join('\n'),
})
decs(web, ['source', 'ack', 'github-issues', '418', '--note', S.issues.fixed])
decs(web, ['source', 'ack', 'github-issues', '420', '--waiting-on', `W${dark}`])
decs(web, ['source', 'register', 'support-inbox', '--title', S.inbox.title, '--kind', 'mail', '--stale-after', '1h'])
decs(web, ['source', 'sync', 'support-inbox'], { input: JSON.stringify({ id: 'm-88', title: S.inbox.item, from: 'customer@example.com' }) })
decs(web, ['source', 'ack', 'support-inbox', 'm-88', '--waiting-on', 'Bob'])

const { initLayout } = await import('../src/core/paths.ts')
const { Store } = await import('../src/core/store.ts')
const { overviewOf } = await import('../src/core/overview.ts')
const { buildFrame, geometry } = await import('../src/tui/app.ts')
const { rowsFor, viewFromArg } = await import('../src/tui/views.ts')
const { RESET } = await import('../src/tui/zoom.ts')
const { graphemes, stringWidth } = await import('../src/tui/width.ts')
const { BIDI_CONTROLS } = await import('../src/i18n/bidi.ts')
type FrameInput = import('../src/tui/app.ts').FrameInput

const store = new Store([initLayout(web), initLayout(api)])
const now = Date.now() + 7 * 60_000
const items = store.all()
const view = viewFromArg(VIEW)
const list = rowsFor(view, items)
const focus = list.findIndex((r) => r.node?.id === copy && r.node?.project === 'web')
const index = focus >= 0 ? focus : list.findIndex((r) => r.node)
const input: FrameInput = {
  view, list, index, current: list[index]?.node, items, overview: overviewOf(store, now), now,
  rows: ROWS, width: COLS, offset: 0, condensed: false, mode: 'browse', draft: '', caret: 0,
  imageSel: 0, pendingKey: null, banner: null, zoom: RESET, zoomable: false, detailFocus: false, imageSize: null,
}
const frame = buildFrame(input, geometry(input))

const CW = 9.6
const LH = 21
const PAD = 22
const BAR = 34
const FONT = 16
const THEME = {
  bg: '#16181d', fg: '#d8dee9', dim: '#6b7280', chrome: '#22252c',
  colors: { red: '#f07178', green: '#a3d98b', yellow: '#f2c66d', blue: '#7aa2f7', magenta: '#c792ea', cyan: '#78d1e1', gray: '#8b93a1', white: '#ffffff' } as Record<string, string>,
}
const CJK_FONT = LANG === 'zh-Hant' ? "'PingFang TC', 'Noto Sans CJK TC'" : "'PingFang SC', 'Noto Sans CJK SC'"
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const width = Math.ceil(COLS * CW + PAD * 2)
const height = Math.ceil(frame.length * LH + PAD * 2 + BAR)
const out: string[] = []
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`)
out.push(`<rect width="${width}" height="${height}" rx="12" fill="${THEME.bg}"/>`)
out.push(`<path d="M0 12a12 12 0 0 1 12-12h${width - 24}a12 12 0 0 1 12 12v${BAR - 12}h-${width}z" fill="${THEME.chrome}"/>`)
for (const [i, c] of ['#ff5f57', '#febc2e', '#28c840'].entries()) out.push(`<circle cx="${22 + i * 20}" cy="${BAR / 2}" r="6" fill="${c}"/>`)
out.push(`<text x="${width / 2}" y="${BAR / 2 + 5}" fill="${THEME.dim}" font-family="Menlo, monospace" font-size="13" text-anchor="middle">nod bench</text>`)
out.push(`<g font-family="'JetBrains Mono', 'SF Mono', Menlo, Consolas, ${CJK_FONT}, 'SF Arabic', 'Noto Sans Arabic', monospace" font-size="${FONT}">`)

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/
const OTHER_LETTER = /\p{L}/u
const NUMBER = /^[0-9][0-9.,:%٪]*$/

/**
 * Splits a segment into runs to draw. The frame holds Arabic in visual order,
 * letter by letter; each stretch with Arabic in it and no other letters — its
 * numbers and punctuation included — is put back in reading order and drawn
 * whole, right to left, so the image shows it shaped.
 */
function runs(text: string): { text: string; rtl: boolean }[] {
  const gs = graphemes(text.replace(BIDI_CONTROLS, ''))
  const out: { text: string; rtl: boolean }[] = []
  const push = (part: string[], rtl: boolean) => {
    if (!part.length) return
    const tail = out[out.length - 1]
    if (tail && tail.rtl === rtl && !rtl) tail.text += part.join('')
    else out.push({ text: rtl ? readingOrder(part) : part.join(''), rtl })
  }
  let i = 0
  while (i < gs.length) {
    const foreign = OTHER_LETTER.test(gs[i]) && !ARABIC.test(gs[i])
    let j = i
    while (j < gs.length && (OTHER_LETTER.test(gs[j]) && !ARABIC.test(gs[j])) === foreign) j++
    const chunk = gs.slice(i, j)
    if (foreign || !chunk.some((g) => ARABIC.test(g))) push(chunk, false)
    else {
      let a = 0
      let b = chunk.length
      while (a < b && chunk[a] === ' ') a++
      while (b > a && chunk[b - 1] === ' ') b--
      push(chunk.slice(0, a), false)
      push(chunk.slice(a, b), true)
      push(chunk.slice(b), false)
    }
    i = j
  }
  return out
}

/** Visual → logical for one right-to-left run: reverse it, keeping each number whole and un-mirroring brackets. */
function readingOrder(gs: string[]): string {
  const atoms: string[] = []
  for (const g of gs) {
    const prev = atoms[atoms.length - 1]
    if (prev !== undefined && NUMBER.test(prev + g) && /[0-9]/.test(prev[0])) atoms[atoms.length - 1] = prev + g
    else atoms.push(g)
  }
  const mirror: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '«': '»', '»': '«', '<': '>', '>': '<', '‹': '›', '›': '‹' }
  return atoms.reverse().map((a) => mirror[a] ?? a).join('')
}

frame.forEach((line, row) => {
  const y = PAD + BAR + row * LH
  let col = 0
  for (const seg of line) {
    const fg = seg.color ? (THEME.colors[seg.color] ?? THEME.fg) : THEME.fg
    const fill = seg.inverse ? THEME.bg : seg.dim ? THEME.dim : fg
    const attrs = [`fill="${fill}"`, seg.bold ? 'font-weight="700"' : '', seg.dim && seg.color ? 'opacity="0.7"' : ''].filter(Boolean).join(' ')
    const start = col
    const texts: string[] = []
    for (const run of runs(seg.text)) {
      if (run.rtl) {
        const w = stringWidth(run.text)
        const right = PAD + (col + w) * CW
        texts.push(`<text x="${right.toFixed(1)}" y="${y + LH - 4}" direction="rtl" text-anchor="start" ${attrs}>${esc(run.text)}</text>`)
        col += w
        continue
      }
      const glyphs: string[] = []
      for (const g of graphemes(run.text)) {
        const w = stringWidth(g)
        const x = PAD + col * CW + (w > 1 ? (w * CW - FONT) / 2 : 0)
        if (g !== ' ') glyphs.push(`<tspan x="${x.toFixed(1)}">${esc(g)}</tspan>`)
        col += w
      }
      if (glyphs.length) texts.push(`<text y="${y + LH - 4}" ${attrs}>${glyphs.join('')}</text>`)
    }
    if (seg.inverse && col > start) {
      out.push(`<rect x="${(PAD + start * CW).toFixed(1)}" y="${y + 2}" width="${((col - start) * CW).toFixed(1)}" height="${LH}" fill="${fg}"/>`)
    }
    out.push(...texts)
  }
})
out.push('</g></svg>')

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(`${OUT}.svg`, `${out.join('\n')}\n`)
const png = spawnSync('rsvg-convert', ['-z', '2', '-o', `${OUT}.png`, `${OUT}.svg`])
console.log(`${OUT}.svg${png.status === 0 ? ` + ${OUT}.png` : ' (no rsvg-convert: PNG skipped)'}`)
rmSync(tmp, { recursive: true, force: true })
