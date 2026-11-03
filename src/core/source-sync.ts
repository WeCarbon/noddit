/**
 * A source's single-sync command, run by a lead `nod monitor` on an interval
 * while it is alive — so a source is polled only while a session is open.
 *
 * The command is stored on this machine only (`~/.decs/source-sync.json`,
 * keyed by project root), never under `decisions/`: those files may be
 * committed and cloned, and cloning a repository must not make anyone's
 * monitor execute a command. Saving it with `nod source register --sync-cmd`
 * on this machine is the trust step.
 *
 *   ~/.decs/source-sync.json            { sources: { <projectRoot>: { <name>: { cmd, every } } } }
 *   ~/.decs/source-sync/<key>.json      last run, shared by every monitor on the machine
 *   ~/.decs/source-sync/<key>.lock      pid of the run in progress — no overlapping runs
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DECS_HOME } from './config.ts'
import type { Layout } from './paths.ts'
import { normalizeDuration, parseDurationMs, validateSourceName } from './sources.ts'
import { t } from '../i18n/index.ts'

export const DEFAULT_SYNC_EVERY = '10m'
export const SYNC_TIMEOUT_MS = 10 * 60_000

export interface SourceSyncSetting {
  cmd: string
  every: string
}

interface SyncFile {
  sources: Record<string, Record<string, SourceSyncSetting>>
}

export interface SyncRunState {
  lastStartedAt?: string
  lastFinishedAt?: string
  lastExit?: number | null
  lastError?: string
}

const settingsPath = (home: string) => join(home, 'source-sync.json')
const runKey = (projectRoot: string, name: string) => createHash('sha1').update(`${projectRoot}\0${name}`).digest('hex').slice(0, 16)
const runStatePath = (home: string, projectRoot: string, name: string) => join(home, 'source-sync', `${runKey(projectRoot, name)}.json`)
const runLockPath = (home: string, projectRoot: string, name: string) => join(home, 'source-sync', `${runKey(projectRoot, name)}.lock`)

function readSyncFile(home: string): SyncFile {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(home), 'utf8')) as Partial<SyncFile>
    return { sources: raw.sources && typeof raw.sources === 'object' ? raw.sources : {} }
  } catch {
    return { sources: {} }
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  renameSync(tmp, path)
}

/** Saves (or, with `null`, removes) a source's sync command for this machine. */
export function setSourceSync(
  layout: Pick<Layout, 'projectRoot'>,
  name: string,
  setting: { cmd: string; every?: string } | null,
  home = DECS_HOME,
): SourceSyncSetting | null {
  validateSourceName(name)
  const file = readSyncFile(home)
  const project = { ...(file.sources[layout.projectRoot] ?? {}) }
  let saved: SourceSyncSetting | null = null
  if (setting && setting.cmd.trim()) {
    const every = normalizeDuration(setting.every ?? project[name]?.every ?? DEFAULT_SYNC_EVERY)
    saved = { cmd: setting.cmd.trim(), every }
    project[name] = saved
  } else {
    delete project[name]
  }
  if (Object.keys(project).length) file.sources[layout.projectRoot] = project
  else delete file.sources[layout.projectRoot]
  writeJsonAtomic(settingsPath(home), file)
  return saved
}

export function sourceSyncOf(layout: Pick<Layout, 'projectRoot'>, name: string, home = DECS_HOME): SourceSyncSetting | undefined {
  const s = readSyncFile(home).sources[layout.projectRoot]?.[name]
  return s && typeof s.cmd === 'string' && s.cmd.trim() ? s : undefined
}

export function sourceSyncsOf(layout: Pick<Layout, 'projectRoot'>, home = DECS_HOME): [string, SourceSyncSetting][] {
  const all = readSyncFile(home).sources[layout.projectRoot] ?? {}
  return Object.entries(all)
    .filter(([, s]) => s && typeof s.cmd === 'string' && s.cmd.trim())
    .sort(([a], [b]) => a.localeCompare(b))
}

export function syncRunStateOf(layout: Pick<Layout, 'projectRoot'>, name: string, home = DECS_HOME): SyncRunState {
  try {
    return JSON.parse(readFileSync(runStatePath(home, layout.projectRoot, name), 'utf8')) as SyncRunState
  } catch {
    return {}
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Takes the per-source run lock, reclaiming one whose holder is gone. */
function tryLock(path: string): number | null {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx')
      writeSync(fd, String(process.pid))
      return fd
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const pid = Number(readFileSafe(path))
      if (pid > 0 && alive(pid)) return null
      rmSync(path, { force: true })
    }
  }
  return null
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

const lastLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''

export interface SourceSyncRunner {
  /** Starts every due, idle sync command; never waits for one to finish. */
  tick(): void
  /** Kills commands this runner started — a monitor going away takes its runs along. */
  stop(): void
  /** Resolves once nothing this runner started is still running (for tests). */
  idle(): Promise<void>
}

export function createSourceSyncRunner(opts: {
  layouts: Layout[]
  onError: (message: string) => void
  home?: string
  now?: () => number
}): SourceSyncRunner {
  const home = opts.home ?? DECS_HOME
  const now = opts.now ?? Date.now
  const running = new Map<string, { child: ChildProcess; done: Promise<void> }>()

  const start = (layout: Layout, name: string, setting: SourceSyncSetting) => {
    const lockPath = runLockPath(home, layout.projectRoot, name)
    const fd = tryLock(lockPath)
    if (fd === null) return
    const statePath = runStatePath(home, layout.projectRoot, name)
    const startedAt = new Date(now()).toISOString()
    let child: ChildProcess
    try {
      child = spawn(setting.cmd, { cwd: layout.projectRoot, shell: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (err) {
      closeSync(fd)
      rmSync(lockPath, { force: true })
      opts.onError(t('core.sourceSync.failed', { name, detail: (err as Error).message }))
      return
    }
    // The lock names the command's own pid, so a monitor that dies mid-run
    // does not let the next one start a second copy.
    if (child.pid) writeFileSync(lockPath, String(child.pid))
    closeSync(fd)
    writeJsonAtomic(statePath, { ...syncRunStateOf(layout, name, home), lastStartedAt: startedAt })

    let stderr = ''
    child.stderr?.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-4000)
    })
    const timer = setTimeout(() => child.kill(), SYNC_TIMEOUT_MS)
    const key = `${layout.projectRoot}\0${name}`
    const done = new Promise<void>((resolve) => {
      let finished = false
      const finish = (code: number | null, detail?: string) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        rmSync(lockPath, { force: true })
        running.delete(key)
        const error = code === 0 ? undefined : detail || lastLine(stderr) || t('core.sourceSync.exitCode', { code: String(code) })
        writeJsonAtomic(statePath, { lastStartedAt: startedAt, lastFinishedAt: new Date(now()).toISOString(), lastExit: code, ...(error ? { lastError: error } : {}) })
        if (error) opts.onError(t('core.sourceSync.failed', { name, detail: error }))
        resolve()
      }
      child.once('error', (err) => finish(null, err.message))
      child.once('close', (code) => finish(code))
    })
    running.set(key, { child, done })
  }

  return {
    tick() {
      for (const layout of opts.layouts) {
        let settings: [string, SourceSyncSetting][]
        try {
          settings = sourceSyncsOf(layout, home)
        } catch (err) {
          opts.onError((err as Error).message)
          continue
        }
        for (const [name, setting] of settings) {
          if (running.has(`${layout.projectRoot}\0${name}`)) continue
          const last = Date.parse(syncRunStateOf(layout, name, home).lastStartedAt ?? '')
          if (!Number.isNaN(last) && now() - last < parseDurationMs(setting.every, 10 * 60_000)) continue
          start(layout, name, setting)
        }
      }
    },
    stop() {
      for (const { child } of running.values()) child.kill()
    },
    async idle() {
      while (running.size) await Promise.all([...running.values()].map((r) => r.done))
    },
  }
}
