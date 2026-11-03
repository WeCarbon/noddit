import { OTHER_KEY, type Bench, type Node, type Project, type RunOutput, type ShellEnv } from './types.ts'

/**
 * Everything the window knows comes from the `decs` CLI: reads are
 * `decs … --json`, writes are plain `decs` commands, live updates are
 * `decs monitor --updates`. Outside the desktop shell (a plain browser,
 * for screenshots) it plays back a recorded `decs bench --json`.
 */
export const inDesktop = '__TAURI_INTERNALS__' in window

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
let invokeFn: Invoke | null = null
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeFn) invokeFn = (await import('@tauri-apps/api/core')).invoke as Invoke
  return invokeFn<T>(cmd, args)
}

export class DecsError extends Error {}

async function run(args: string[], cwd?: string, stdin?: string): Promise<RunOutput> {
  if (!inDesktop) return demoRun(args)
  return invoke<RunOutput>('decs', { args, cwd: cwd ?? null, stdin: stdin ?? null })
}

async function ok(args: string[], cwd?: string, stdin?: string): Promise<string> {
  const out = await run(args, cwd, stdin)
  if (out.code !== 0) throw new DecsError((out.stderr || out.stdout).replace(/^nod [a-z]+: /, '').trim())
  return out.stdout
}

export async function shellEnv(refresh = false): Promise<ShellEnv> {
  if (!inDesktop) return { path: '', node: '/usr/local/bin/node', node_version: 'v22.18.0', npm: '/usr/local/bin/npm', decs: '/usr/local/bin/nod', decs_version: '0.1.0' }
  return invoke<ShellEnv>('shell_env', { refresh })
}

export async function installDecs(): Promise<RunOutput> {
  return invoke<RunOutput>('install_decs')
}

export const loadBench = async (): Promise<Bench> => JSON.parse(await ok(['bench', '--json']))

export const loadNode = async (root: string, id: number): Promise<Node> => JSON.parse(await ok(['bench', '--json', '--node', String(id), '--dir', root]))

/** The project root a `file` path (as `decs bench --json` writes it) sits
 *  under — everything before `/decisions/`. Windows paths from the CLI use
 *  `\`; tried second since a path can't contain both. */
export function rootFromFile(file: string): string | null {
  for (const marker of ['/decisions/', '\\decisions\\']) {
    const i = file.indexOf(marker)
    if (i !== -1) return file.slice(0, i)
  }
  return null
}

export const listProjects = async (): Promise<Project[]> =>
  (JSON.parse(await ok(['projects', '--json'])) as { name: string; display_name?: string; root: string; letter?: string }[]).map((p) => ({ project: p.name, name: p.display_name ?? p.name, root: p.root, letter: p.letter ?? '' }))

const human = ['--human']

/** Files from a paste or a drop, saved where nod can attach them; their paths in the same order. */
async function saveUploads(files: File[]): Promise<string[]> {
  const paths: string[] = []
  if (!inDesktop) return paths
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer())
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    paths.push(await invoke<string>('save_upload', { name: f.name || 'pasted.png', data: btoa(bin) }))
  }
  return paths
}

/** The owner's answer note was just written: its files go under it. */
async function attachToAnswer(root: string, id: number, files: File[]): Promise<void> {
  const paths = await saveUploads(files)
  if (paths.length) await ok(['attach', String(id), ...paths, '--to', 'last', ...human, '--dir', root])
}

export const answer = async (root: string, id: number, choice: string, note?: string, files: File[] = []) => {
  await ok(['push', String(id), choice, ...(note ? ['--note', note] : []), ...human, '--dir', root])
  await attachToAnswer(root, id, files)
}

/** `otherText[q]` is the typed answer for any question picked `OTHER_KEY` — carried in the same
 *  token (`Qx=*:<text>`) push already reads, so the CLI never sees a bare, text-less `*`. */
export const answerQuestions = (root: string, id: number, picks: Record<string, string>, otherText: Record<string, string> = {}, note?: string) =>
  ok([
    'push',
    String(id),
    ...Object.entries(picks).map(([q, k]) => (k === OTHER_KEY ? `${q}=${OTHER_KEY}:${otherText[q] ?? ''}` : `${q}=${k}`)),
    ...(note ? ['--note', note] : []),
    ...human,
    '--dir',
    root,
  ])

export const answerDefaults = (root: string, id: number) => ok(['push', String(id), '--defaults', ...human, '--dir', root])

export const answerFreeText = async (root: string, id: number, note: string, files: File[] = []) => {
  await ok(['push', String(id), '--note', note, ...human, '--dir', root])
  await attachToAnswer(root, id, files)
}

/** One `nod note … --attach …`: the reply and the files it presents land in the same section. */
export const reply = async (root: string, id: number, text: string, files: File[] = []) => {
  const paths = await saveUploads(files)
  return ok(['note', String(id), text, ...paths.flatMap((p) => ['--attach', p]), ...human, '--dir', root])
}

export const defer = (root: string, id: number, off: boolean) => ok(['defer', String(id), ...(off ? ['--off'] : []), ...human, '--dir', root])

/** `nod order`: these nodes in this order, above the ones never moved. `root` when they share a project. */
export const order = (refs: string[], root?: string) => ok(['order', ...refs, ...(root ? ['--dir', root] : [])])

/** The owner's marks: important, a milestone on `due` (YYYY-MM-DD or 3d), or normal (both off). */
export const flag = (root: string, id: number, how: 'important' | 'milestone' | 'normal', due?: string) =>
  ok(['flag', String(id), how, ...(due ? ['--due', due] : []), '--dir', root])

export const close = (root: string, id: number, reason: string) => ok(['close', String(id), '--reason', reason, '--dir', root])

export const seen = (root: string, id: number) => ok(['archive', String(id), '--seen', '--dir', root])

export const start = (root: string, id: number) => ok(['start', String(id), '--dir', root])

export const done = (root: string, id: number) => ok(['done', String(id), '--dir', root])

/** Empty goes back to the folder name. */
export const renameProject = (root: string, name: string) => ok(['config', 'name', ...(name ? [name] : ['--off']), '--dir', root])

export const setLetter = (root: string, letter: string) => ok(['config', 'letter', letter, '--dir', root])

/** Forgets the project in the registry; its folder and decisions/ are left alone. */
export const unlinkProject = (root: string) => ok(['projects', 'remove', root, '--json'])

export async function reveal(path: string): Promise<void> {
  if (!inDesktop) return
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
  await revealItemInDir(path)
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const t = document.createElement('textarea')
    t.value = text
    document.body.append(t)
    t.select()
    document.execCommand('copy')
    t.remove()
  }
}

/** Native OS menus in the desktop app, except in background (test) mode. */
export const useNativeMenus = async (): Promise<boolean> => (inDesktop ? !(await invoke<boolean>('is_background').catch(() => false)) : false)

export const isDebugBuild = async (): Promise<boolean> => (inDesktop ? invoke<boolean>('is_debug').catch(() => false) : true)

/** iTerm2 or macOS Terminal, when a monitor's heartbeat could tell which session/tab it runs in. */
export interface SessionTerminal {
  type: 'mac-iterm2' | 'mac-terminal'
  id: string
}

export interface Session {
  pid: number
  author: string | null
  harness: 'claude-code' | 'codex' | null
  role: 'lead' | 'teammate' | 'main'
  started_at: string
  last_seen: string
  terminal?: SessionTerminal
}

export interface ProjectSessions {
  project: string
  letter: string
  root: string
  listening: boolean
  sessions: Session[]
}

/** Which projects have an AI session listening; older CLIs without `sessions` report none. */
export async function sessions(): Promise<ProjectSessions[] | null> {
  if (!inDesktop) return demoSessions()
  const out = await run(['sessions', '--json'])
  if (out.code !== 0) return null
  try {
    return (JSON.parse(out.stdout) as { projects: ProjectSessions[] }).projects
  } catch {
    return null
  }
}

export interface FiledBrief {
  ref: string
  id: number
  project: string
  title: string
  listening?: boolean
}

/** The owner's own words, filed for an AI to pick up and expand. More than one line goes in on stdin. */
export async function fileBrief(root: string, text: string, parentRef?: string, important = false): Promise<FiledBrief> {
  const words = text.trim()
  const multi = words.includes('\n')
  const title = words.split('\n')[0].trim()
  const args = ['add', title, '--brief', ...(parentRef ? ['--parent', parentRef] : []), ...(important ? ['--urgency', 'high'] : []), '--dir', root, '--json']
  if (!inDesktop) return { ref: 'W11', id: 11, project: 'web', title, listening: false }
  return JSON.parse(await ok(args, undefined, multi ? words : undefined)) as FiledBrief
}

export type AgentKind = 'claude' | 'codex' | 'kimi'

export interface SessionStart {
  ok: boolean
  started?: boolean
  reason?: string
  plan?: { agent: string; root: string; terminal: string; command: string; exec: unknown }
  dry_run?: boolean
}

/** Opens a terminal in the project running the agent, which then picks up what is waiting. */
export async function startSession(root: string, agent: AgentKind): Promise<SessionStart> {
  if (!inDesktop) return { ok: true, started: true, dry_run: true }
  const out = await run(['session', 'start', '--agent', agent, '--dir', root, '--json'])
  try {
    return JSON.parse(out.stdout) as SessionStart
  } catch {
    throw new DecsError((out.stderr || out.stdout).replace(/^nod [a-z]+: /, '').trim())
  }
}

/** Brings the project's main session's terminal window/tab to the front. `false` (never a thrown
 *  error) when it is no longer there — iTerm2/Terminal closed, or nothing was ever recorded. */
export async function gotoSession(root: string): Promise<boolean> {
  if (!inDesktop) return true
  const out = await run(['session', 'goto', '--dir', root, '--json'])
  try {
    return Boolean((JSON.parse(out.stdout) as { ok: boolean }).ok)
  } catch {
    return false
  }
}

/** The cross-project main session (`nod session start --main`), when it is live; null otherwise or on an older CLI. */
export async function mainSession(): Promise<Session | null> {
  if (!inDesktop) return null
  const out = await run(['sessions', '--json'])
  if (out.code !== 0) return null
  try {
    return (JSON.parse(out.stdout) as { main?: Session | null }).main ?? null
  } catch {
    return null
  }
}

/** `nod session goto --main`; `false` when its terminal is no longer there. */
export async function gotoMainSession(): Promise<boolean> {
  if (!inDesktop) return true
  const out = await run(['session', 'goto', '--main', '--json'])
  try {
    return Boolean((JSON.parse(out.stdout) as { ok: boolean }).ok)
  } catch {
    return false
  }
}

function demoSessions(): ProjectSessions[] {
  const now = new Date().toISOString()
  return [
    { project: 'web', letter: 'W', root: '/Users/alice/Code/web', listening: true, sessions: [{ pid: 1, author: 'lane-auth', harness: 'claude-code', role: 'lead', started_at: now, last_seen: now }] },
    { project: 'api', letter: 'A', root: '/Users/alice/Code/api', listening: false, sessions: [] },
  ]
}

export const initProject = (dir: string) => ok(['init', dir])

export const addProject = (dir: string) => ok(['projects', 'add', dir])

export type Agent = 'claude' | 'codex' | 'kimi'

export interface AgentSetup {
  detected: boolean
  action: 'skipped' | 'created' | 'updated' | 'unchanged' | 'manual' | 'error'
  detail: string
  file?: string
}

export interface SetupResult {
  dir: string
  dryRun: boolean
  agents: Partial<Record<Agent, AgentSetup>>
}

/** `decs setup`: teaches the project's agents to ask through decs. `dryRun` only reports what is detected. */
export async function setupAgents(dir: string, agents: Agent[], dryRun = false): Promise<SetupResult> {
  if (!inDesktop) return demoSetup(agents, dryRun)
  const out = await run(['setup', '--json', '--for', agents.join(','), '--dir', dir, ...(dryRun ? ['--dry-run'] : [])])
  try {
    return JSON.parse(out.stdout) as SetupResult
  } catch {
    throw new DecsError((out.stderr || out.stdout).replace(/^nod [a-z]+: /, '').trim())
  }
}

function demoSetup(agents: Agent[], dryRun: boolean): SetupResult {
  const result: SetupResult['agents'] = {}
  for (const a of agents)
    result[a] = a === 'kimi' ? { detected: false, action: 'skipped', detail: 'kimi not found on PATH' } : { detected: true, action: dryRun ? 'unchanged' : 'created', detail: '' }
  return { dir: '/Users/alice/Code/api', dryRun, agents: result }
}

/** `onLine` gets every `decs monitor` line as it arrives (N258: the caller
 *  decides whether it can patch just the named nodes or needs a full reload). */
export async function startMonitor(onLine: (line: string) => void): Promise<void> {
  if (!inDesktop) return
  await on<string>('decs-event', onLine)
  await invoke('monitor_start').catch(() => {})
}

/** Events the app side sends this window: `summon` (hotkey or tray, with a node key), `open-settings`, `banner-show`. */
export async function on<T>(event: string, handler: (payload: T) => void): Promise<void> {
  if (!inDesktop) return
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const { listen } = await import('@tauri-apps/api/event')
  if (event === 'decs-event' || event === 'waiting') await listen<T>(event, (e) => handler(e.payload))
  else await getCurrentWebviewWindow().listen<T>(event, (e) => handler(e.payload))
}

export type NotifyStyle = 'system' | 'banner' | 'off'

export interface AppSettings {
  notify: NotifyStyle
  hotkey: string
  keepInTray: boolean
}

export interface SettingsView {
  settings: AppSettings
  defaultHotkey: string
  ctrlSpaceTaken: boolean
  hotkeyError: string | null
}

export async function settingsGet(): Promise<SettingsView> {
  if (!inDesktop) return { settings: { notify: 'system', hotkey: 'Ctrl+Alt+Space', keepInTray: true }, defaultHotkey: 'Ctrl+Alt+Space', ctrlSpaceTaken: true, hotkeyError: null }
  return invoke<SettingsView>('settings_get')
}

export const settingsSet = (settings: AppSettings) => (inDesktop ? invoke<void>('settings_set', { settings }) : Promise.resolve())

export const setPhrases = (phrases: { needsDecision: string; notCollected: string; milestoneDay: string; milestoneHour: string; milestone: string; agentReplied: string; open: string; settings: string; quit: string }) => (inDesktop ? invoke('set_phrases', { phrases }).catch(() => {}) : Promise.resolve())

export const summoned = (what: string) => (inDesktop ? invoke('summoned', { what }).catch((e) => log(`summoned: ${e}`)) : Promise.resolve())

export const bannerHide = () => (inDesktop ? invoke('banner_hide').catch(() => {}) : Promise.resolve())

/** A notice for the banner window (the main window is not in front). */
export const noticeBanner = (item: unknown) => (inDesktop ? invoke('notice_banner', { item }).catch(() => {}) : Promise.resolve())
/** The banner window's notices need this much height. */
export const bannerFit = (height: number) => (inDesktop ? invoke('banner_fit', { height }).catch(() => {}) : Promise.resolve())
/** The OS notification, for a notice only the window knows about. */
export const noticeSystem = (title: string, body: string) => (inDesktop ? invoke('notice_system', { title, body }).catch(() => {}) : Promise.resolve())

export const bannerOpenMain = (key: string) => (inDesktop ? invoke('banner_open_main', { key }).catch(() => {}) : Promise.resolve())

export interface WaitingNode {
  key: string
  id: number
  ref: string
  project: string
  title: string
  root: string
  options: { key: string; label: string }[]
  default: string | null
  urgent: boolean
}

export async function waitingGet(): Promise<WaitingNode[]> {
  if (!inDesktop) return []
  return invoke<WaitingNode[]>('waiting_get')
}

export async function snapshotLoad(): Promise<Bench | null> {
  if (!inDesktop) return null
  const text = await invoke<string | null>('snapshot_load')
  try {
    return text ? (JSON.parse(text) as Bench) : null
  } catch {
    return null
  }
}

export const snapshotSave = (bench: string) => (inDesktop ? invoke('snapshot_save', { json: bench }).catch(() => {}) : Promise.resolve())

export async function prefsLoad<T>(fallback: T): Promise<T> {
  try {
    if (!inDesktop) return { ...fallback, ...JSON.parse(localStorage.getItem('decs-prefs') ?? '{}') }
    const text = await invoke<string | null>('prefs_load')
    return text ? { ...fallback, ...JSON.parse(text) } : fallback
  } catch {
    return fallback
  }
}

export function prefsSave(prefs: unknown): void {
  const text = JSON.stringify(prefs)
  if (!inDesktop) {
    try {
      localStorage.setItem('decs-prefs', text)
    } catch {
      /* private mode */
    }
    return
  }
  invoke('prefs_save', { json: text }).catch(() => {})
}

/** Shows the window on the first call; each call logs how long after launch `what` happened (NODDIT_APP_TIMING=1, or the older DECS_APP_TIMING). */
export async function ready(what: string): Promise<number> {
  if (!inDesktop) return performance.now()
  return invoke<number>('ready', { what })
}

export function log(line: string): void {
  if (inDesktop) invoke('log', { line }).catch(() => {})
  else console.error(line)
}

export async function pickFolder(): Promise<string | null> {
  if (!inDesktop) return '/Users/alice/Code/api'
  return invoke<string | null>('pick_folder')
}

export async function openPath(path: string): Promise<void> {
  if (!inDesktop) return
  const { openPath, openUrl } = await import('@tauri-apps/plugin-opener')
  await (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) ? openUrl(path) : openPath(path))
}

let convert: ((p: string) => string) | null = null
export async function prepareImages(): Promise<void> {
  if (inDesktop && !convert) convert = (await import('@tauri-apps/api/core')).convertFileSrc
}

export function imageSrc(path: string): string {
  if (/^https?:\/\//.test(path)) return path
  if (!inDesktop) return `demo/${path.split('/').pop()}`
  return convert ? convert(path) : path
}

async function demoRun(args: string[]): Promise<RunOutput> {
  if (args[0] === 'bench' && !args.includes('--node')) {
    const lang = new URLSearchParams(location.search).get('lang')
    const res = await fetch(lang && lang !== 'en' ? `demo/bench.${lang}.json` : 'demo/bench.json')
    return { code: 0, stdout: await res.text(), stderr: '' }
  }
  if (args[0] === 'bench' && args.includes('--node')) return { code: 1, stdout: '', stderr: 'not in the demo' }
  if (args[0] === 'projects' && args[1] !== 'remove') return { code: 0, stdout: JSON.stringify(demoProjects()), stderr: '' }
  return { code: 0, stdout: '', stderr: '' }
}

function demoProjects() {
  const empty = new URLSearchParams(location.search).get('screen') === 'onboarding'
  return empty ? [] : [{ name: 'web', root: '/Users/alice/Code/web' }]
}

/** One shared setting, as `nod config --json` describes it (the terminal bench's `,` dialog shows the same list). */
export interface SharedSetting {
  key: string
  label: string
  type: 'enum' | 'bool' | 'duration'
  value: string
  value_label: string
  default: string
  source: 'env' | 'config' | 'default'
  env: string | null
  choices: { value: string; label: string }[]
}

const DEMO_SHARED: SharedSetting[] = [
  { key: 'lang', label: 'Language', type: 'enum', value: 'auto', value_label: 'automatic', default: 'auto', source: 'default', env: null, choices: [{ value: 'auto', label: 'automatic' }, { value: 'en', label: 'English' }, { value: 'zh-Hans', label: '简体中文' }] },
  { key: 'mouse', label: 'Mouse', type: 'bool', value: 'on', value_label: 'on', default: 'on', source: 'default', env: null, choices: [{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }] },
]

export const sharedSettings = async (): Promise<SharedSetting[]> =>
  inDesktop ? (JSON.parse(await ok(['config', '--json'])) as { settings: SharedSetting[] }).settings : DEMO_SHARED

/** Sets one (`null`: back to its default) and returns it as it now stands. */
export const setSharedSetting = async (key: string, value: string | null): Promise<SharedSetting | null> =>
  inDesktop ? (JSON.parse(await ok(['config', key, ...(value === null ? ['--off'] : [value]), '--json'])) as SharedSetting) : null

/** What `nod date "<text>" --json` read: a loose date, as the owner types it. */
export interface DateSuggestion {
  key: string
  label: string
  date: string
  text: string
  relative: string
}
export interface DateRead {
  ok: boolean
  date: string | null
  text: string | null
  relative: string | null
  hint?: string
  suggestions: DateSuggestion[]
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The browser demo's stand-in: a few English words and YYYY-MM-DD. */
function demoDate(text: string): DateRead {
  const day = (n: number) => isoDay(new Date(Date.now() + n * 86_400_000))
  const picks: DateSuggestion[] = [
    { key: 'tomorrow', label: 'tomorrow', date: day(1), text: day(1), relative: 'in a day' },
    { key: 'week', label: 'next week', date: day(7), text: day(7), relative: 'in 7 days' },
    { key: 'month', label: 'next month', date: day(30), text: day(30), relative: 'in a month' },
  ]
  const t = text.trim().toLowerCase()
  if (!t) return { ok: true, date: null, text: null, relative: null, suggestions: picks }
  const hit = picks.find((p) => p.label === t) ?? (/^\d{4}-\d{2}-\d{2}$/.test(t) ? { date: t, text: t, relative: '' } : null)
  return hit ? { ok: true, date: hit.date, text: hit.text, relative: hit.relative, suggestions: picks } : { ok: false, date: null, text: null, relative: null, suggestions: picks }
}

export async function readDate(text: string): Promise<DateRead> {
  if (!inDesktop) return demoDate(text)
  const out = await run(['date', text, '--json'])
  try {
    return JSON.parse(out.stdout) as DateRead
  } catch {
    return { ok: false, date: null, text: null, relative: null, hint: (out.stderr || '').trim(), suggestions: [] }
  }
}

export type Who = 'me' | 'ai' | 'brief'

export interface NewNode {
  title: string
  who: Who
  parentRef?: string
  important: boolean
  /** YYYY-MM-DD, or a loose date nod reads. */
  milestone?: string
  start: boolean
}

/** `nod add`, then `nod start` if it is to begin now. Returns the new node as `nod add --json` prints it. */
export async function addNode(root: string, n: NewNode): Promise<{ id: number; ref: string; project: string }> {
  const args = [
    'add', n.title,
    ...(n.who === 'me' ? ['--for', 'me'] : n.who === 'ai' ? ['--task'] : ['--brief']),
    ...(n.parentRef ? ['--parent', n.parentRef] : []),
    ...(n.important ? ['--important'] : []),
    ...(n.milestone ? ['--milestone', '--due', n.milestone] : []),
    '--dir', root, '--json',
  ]
  if (!inDesktop) return { id: 12, ref: 'W12', project: 'web' }
  const made = JSON.parse(await ok(args)) as { id: number; ref: string; project: string }
  if (n.start && n.who !== 'brief') await ok(['start', String(made.id), '--dir', root])
  return made
}

/** Defer until a day (the node comes back on its own then), or indefinitely with `null`. */
export const assign = (root: string, id: number, who: 'me' | 'ai') => ok(['assign', String(id), who, '--dir', root])

/** The first megabyte of an attachment as text, for the in-app viewer. */
export async function readPreview(path: string): Promise<{ text: string; truncated: boolean; size: number }> {
  if (!inDesktop) {
    const r = await fetch(imageSrc(path))
    const text = await r.text()
    return { text: text.slice(0, 1_048_576), truncated: text.length > 1_048_576, size: text.length }
  }
  return invoke('read_preview', { path, max: 1_048_576 })
}

/** `nod edit`: the description (`body`) or note `index` (0-based) becomes `markdown`. `expect`: the updated_at it was opened at. */
export const editNode = (root: string, id: number, target: 'body' | number, markdown: string, expect?: string) =>
  ok(['edit', String(id), ...(target === 'body' ? ['--body'] : ['--note', String(target + 1)]), ...(expect ? ['--expect', expect] : []), '--human', '--dir', root], undefined, markdown)

/** `nod retitle`. `expect`: the updated_at it was opened at — a write since then refuses. */
export const retitleNode = (root: string, id: number, title: string, expect?: string) =>
  ok(['retitle', String(id), title, ...(expect ? ['--expect', expect] : []), ...human, '--json', '--dir', root])

/** Files pasted or dropped into the editor: saved, then attached to that part of the node. */
export async function attachFiles(root: string, id: number, files: File[], to: 'body' | number): Promise<void> {
  for (const path of await saveUploads(files)) await ok(['attach', String(id), path, '--to', to === 'body' ? 'body' : String(to + 1), '--dir', root])
}

/** One view as `nod views --json` lists it: its definition plus how it reads. */
export interface ViewDef {
  id: string
  name?: string | Record<string, string>
  icon?: string
  layout: 'tree' | 'list'
  group?: string
  sort?: string[]
  finished?: string
  deferred?: string
  window?: { days?: number; max?: number }
  count?: boolean
  label: string
  filter_text?: string
  builtin: boolean
  pristine: boolean
}

export interface ViewsList {
  file: string
  views: ViewDef[]
  schema: { layouts: string[]; groups: string[]; finished: string[]; deferred: string[]; sort: string[]; filter_fields: string[]; is_values: string[]; builtin: string[] }
}

const DEMO_VIEWS: ViewsList = {
  file: '~/.decs/views.json',
  views: [
    { id: 'available', icon: 'list-todo', layout: 'tree', label: 'Available', filter_text: 'state:in_progress,waiting,needs_decision,decided or state:not_started is:startable', builtin: true, pristine: true },
    { id: 'decide', icon: 'hand', layout: 'list', group: 'project', sort: ['blocks_ai', 'flag', 'bench'], label: 'Human work', filter_text: 'state:needs_decision or assignee:human', builtin: true, pristine: true },
    { id: 'waiting', icon: 'hourglass', layout: 'list', group: 'none', sort: ['check_back', 'flag', 'waiting_since'], deferred: 'show', label: 'Waiting', filter_text: 'state:waiting or is:delayed', builtin: true, pristine: true },
  ],
  schema: {
    layouts: ['tree', 'list'],
    groups: ['project', 'state', 'assignee', 'none'],
    finished: ['hide', 'show', 'fold'],
    deferred: ['hide', 'show', 'fold'],
    sort: ['bench', 'blocks_ai', 'flag', 'manual', 'urgency', 'due', 'created', 'updated', 'waiting_since', 'touched', 'changed', 'id', 'title', 'state'],
    filter_fields: ['state', 'assignee', 'flag', 'kind', 'project', 'author', 'tag', 'is', 'due', 'updated', 'title'],
    is_values: ['startable', 'deferred', 'delayed', 'blocks_ai', 'brief', 'touched', 'finished', 'archived', 'stale', 'root', 'parent'],
    builtin: ['available', 'active', 'decide', 'waiting', 'live', 'all'],
  },
}

export const viewsList = async (): Promise<ViewsList> => (inDesktop ? (JSON.parse(await ok(['views', '--json'])) as ViewsList) : DEMO_VIEWS)

/** The definition as `--def` takes it: the filter in its text form. */
const defJson = (d: Partial<ViewDef> & { filter?: string }) => {
  const { label: _l, filter_text, builtin: _b, pristine: _p, ...rest } = d as ViewDef & { filter?: string }
  return JSON.stringify({ ...rest, ...(filter_text !== undefined ? { filter: filter_text } : {}) })
}

/** How many nodes `d` would list right now (an unsaved definition, nothing written). */
export async function previewView(d: ViewDef): Promise<number> {
  if (!inDesktop) return 3
  const b = JSON.parse(await ok(['bench', '--json', '--def', defJson({ ...d, id: d.id })])) as { views: { rows: { kind: string; context?: boolean }[] }[] }
  return (b.views[0]?.rows ?? []).filter((r) => r.kind === 'node' && !r.context).length
}

export const editView = (id: string, patch: Partial<ViewDef> & { filter?: string; name?: string }) => {
  const { name, ...def } = patch
  return ok(['view', 'edit', id, '--def', JSON.stringify(def), ...(name !== undefined ? ['--name', name] : []), '--json'])
}
export const addView = (id: string, def: Record<string, unknown>) => ok(['view', 'add', id, '--def', JSON.stringify(def), '--json'])
export const removeView = (id: string) => ok(['view', 'rm', id])
export const resetViews = (id?: string) => ok(['view', 'reset', ...(id ? [id] : [])])
/** `n` is 1-based, as nod view move takes it. */
export const moveView = (id: string, n: number) => ok(['view', 'move', id, String(n)])

/** 等待: held up on `on` until `date` (YYYY-MM-DD or a loose date), the day to check back. `on` left out moves only the day. */
/**
 * 延迟 (`nod defer`): `on` makes it a wait on someone or something; with `on` null a node already
 * waiting only moves its day, unless `passive` turns it into a plain deferral first.
 */
export const delay = async (root: string, id: number, on: string | null, date: string | null, passive = false) => {
  if (passive) await defer(root, id, true)
  return ok(['defer', String(id), ...(on ? ['--on', on] : []), ...(date ? ['--until', date] : []), ...human, '--dir', root])
}
