import type { Bench, Node, Project, RunOutput, ShellEnv } from './types.ts'

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

export const listProjects = async (): Promise<Project[]> =>
  (JSON.parse(await ok(['projects', '--json'])) as { name: string; display_name?: string; root: string; letter?: string }[]).map((p) => ({ project: p.name, name: p.display_name ?? p.name, root: p.root, letter: p.letter ?? '' }))

const human = ['--human']

export const answer = (root: string, id: number, choice: string, note?: string) =>
  ok(['push', String(id), choice, ...(note ? ['--note', note] : []), ...human, '--dir', root])

export const answerQuestions = (root: string, id: number, picks: Record<string, string>, note?: string) =>
  ok(['push', String(id), ...Object.entries(picks).map(([q, k]) => `${q}=${k}`), ...(note ? ['--note', note] : []), ...human, '--dir', root])

export const answerDefaults = (root: string, id: number) => ok(['push', String(id), '--defaults', ...human, '--dir', root])

export const answerFreeText = (root: string, id: number, note: string) => ok(['push', String(id), '--note', note, ...human, '--dir', root])

export const reply = (root: string, id: number, text: string) => ok(['note', String(id), text, ...human, '--dir', root])

export const defer = (root: string, id: number, off: boolean) => ok(['defer', String(id), ...(off ? ['--off'] : []), ...human, '--dir', root])

export const pin = (root: string, id: number, where: 'top' | 'bottom' | 'off') => ok(['pin', String(id), where, '--dir', root])

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

export interface Session {
  pid: number
  author: string | null
  harness: 'claude-code' | 'codex' | null
  role: 'lead' | 'teammate'
  started_at: string
  last_seen: string
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

export async function startMonitor(onChange: () => void): Promise<void> {
  if (!inDesktop) return
  await on<string>('decs-event', () => onChange())
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
