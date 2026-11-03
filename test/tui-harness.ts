/**
 * The real bench App on fake stdin/stdout: keys and mouse reports in, frames
 * and image escape sequences out. Nothing reaches the real terminal, and
 * DECS_IMAGES is pinned so no code path hands a file to `open`.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { render } from 'ink'

import type { Store } from '../src/core/store.ts'
import { App } from '../src/tui/app.ts'
import type { View } from '../src/tui/views.ts'

class FakeOut extends EventEmitter {
  columns = 120
  rows = 30
  isTTY = true
  chunks: string[] = []
  write(s: string) {
    this.chunks.push(s)
    return true
  }
}

class FakeIn extends EventEmitter {
  isTTY = true
  queue: string[] = []
  setRawMode() {}
  setEncoding() {}
  ref() {}
  unref() {}
  resume() {}
  pause() {}
  read() {
    return this.queue.shift() ?? null
  }
}

export const KEY = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D' }
const strip = (s: string) => s.replace(/\x1b_G[^\x1b]*\x1b\\/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

export function bench(
  t: { after: (fn: () => void) => void },
  store: Store,
  opts: { view?: View; openDeferred?: boolean; columns?: number; rows?: number; home?: string } = {},
) {
  // fold state lives under DECS_HOME, never the real ~/.decs; pass `home` to reopen the same state
  const prevHome = process.env.DECS_HOME
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'decs-home-'))
  process.env.DECS_HOME = home
  const prev = process.env.DECS_IMAGES
  // pinned so showImage takes the in-terminal path, not `open` (which must never run in a test)
  process.env.DECS_IMAGES = 'kitty'
  const out = new FakeOut()
  if (opts.columns) out.columns = opts.columns
  if (opts.rows) out.rows = opts.rows
  const inp = new FakeIn()
  const inst = render(h(App, { store, view: opts.view ?? 'all', openDeferred: opts.openDeferred }), {
    stdout: out as unknown as NodeJS.WriteStream,
    stdin: inp as unknown as NodeJS.ReadStream,
    stderr: out as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  t.after(() => {
    inst.unmount()
    process.env.DECS_IMAGES = prev
    if (prev === undefined) delete process.env.DECS_IMAGES
    process.env.DECS_HOME = prevHome
    if (prevHome === undefined) delete process.env.DECS_HOME
    if (!opts.home) rmSync(home, { recursive: true, force: true })
  })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const frame = (): string[] => {
    const last = [...out.chunks].reverse().find((c) => strip(c).trim().length > 40) ?? ''
    return strip(last).split('\n')
  }
  const draws = (from = 0) =>
    out.chunks.slice(from).flatMap((c) =>
      [...c.matchAll(/\x1b\[(\d+);(\d+)H\x1b_Ga=T[^;]*;([^\x1b]*)\x1b\\/g)].map((m) => ({
        row: Number(m[1]),
        col: Number(m[2]),
        data: Buffer.from(m[3], 'base64').toString(),
      })),
    )
  return {
    out,
    home,
    unmount: () => inst.unmount(),
    frame,
    draws,
    /** Sends keys, each once the previous one has had a moment to land. */
    async press(...keys: string[]) {
      for (const k of keys) {
        await sleep(30)
        inp.queue.push(k)
        inp.emit('readable')
      }
    },
    /** Polls for the screen to match, rather than a fixed sleep; fails the test after `ms` (3s). */
    async until(ok: () => boolean, ms = 3000) {
      for (let waited = 0; waited < ms; waited += 20) {
        if (ok()) return
        await sleep(20)
      }
      if (!ok()) throw new Error(`the screen never matched:\n${frame().join('\n')}`)
    },
    /** Index of the last chunk that drew a picture, and of the last one that wrote a frame. */
    order() {
      const last = (pred: (c: string) => boolean) => out.chunks.findLastIndex(pred)
      return { draw: last((c) => c.includes('\x1b_Ga=T')), frame: last((c) => strip(c).trim().length > 40) }
    },
    /** For "nothing happened" checks: give anything that would happen time to. */
    quiet: () => sleep(250),
  }
}


export const has = (b: { frame: () => string[] }, re: RegExp) => () => re.test(b.frame().join('\n'))
