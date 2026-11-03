import { Bot, CalendarClock, MessageCircleQuestion, CornerLeftUp, GitFork, Link2, Paperclip, PenLine, Radio, Star, Timer, User } from 'lucide-preact'
import { limitInput } from './limit-input.ts'
import type { ComponentChildren } from 'preact'
import { useRef } from 'preact/hooks'
import { useDialogFocus } from './focus.ts'
import { Bar, Glyph, segClass } from './segs.tsx'
import { s } from './strings.ts'
import type { Approval, Node, NodePill, Seg } from './types.ts'

/**
 * The phrase for where one outbound attachment stands — `nod get`'s and the TUI's own wording,
 * ported to the app's strings so the owner reads the same state in both (core/render.ts:approvalLabel).
 */
export function approvalLabel(ap: Approval): string {
  const on = ap.approve_on?.length ? s('approvalOnHint', { approveOn: ap.approve_on.join(' / ') }) : ''
  if (!ap.approved_hash) return ap.declined ? `${s('approvalDeclined', { answer: ap.declined })}${on}` : `${s('approvalPending')}${on}`
  if (ap.approved_hash !== ap.hash) return s('approvalChanged')
  return s('approvalApproved', { by: ap.approved_by ?? 'owner' })
}

/** ✓ approved / pending / declined / needs re-approval, same colours as the TUI's. */
function approvalTone(ap: Approval): string {
  if (ap.approved_hash && ap.approved_hash === ap.hash) return 'c-green'
  return ap.declined ? 'c-red' : 'c-yellow'
}

const ICON = { size: 13, strokeWidth: 1.75 } as const

let rtf: Intl.RelativeTimeFormat | null = null
let rtfLang = ''
/** "5 min ago" in the window's language. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return ''
  const lang = document.documentElement.lang || 'en'
  if (!rtf || rtfLang !== lang) {
    rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' })
    rtfLang = lang
  }
  const sec = Math.round((Date.parse(iso) - now) / 1000)
  const abs = Math.abs(sec)
  if (abs < 45) return rtf.format(0, 'second')
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour')
  return rtf.format(Math.round(sec / 86400), 'day')
}

const fullTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(document.documentElement.lang || undefined) : '')

function Chip({ icon, children, title, tone }: { icon: ComponentChildren; children: ComponentChildren; title?: string; tone?: string }) {
  return (
    <span class={`mchip ${tone ?? ''}`} title={title ?? (typeof children === 'string' ? children : undefined)}>
      {icon}
      <span class="mchip-text">{children}</span>
    </span>
  )
}

function Pills({ icon, label, nodes, onJump }: { icon: ComponentChildren; label: string; nodes: NodePill[]; onJump: (key: string) => void }) {
  if (!nodes.length) return null
  return (
    <span class="pills" title={label}>
      <span class="pills-icon" aria-label={label}>
        {icon}
      </span>
      {nodes.map((n, i) =>
        n.key ? (
          <button key={i} class="npill" onClick={() => onJump(n.key!)} title={n.title ?? ''}>
            <Glyph g={n.glyph ?? undefined} />
            <span class="npill-ref">{n.ref}</span>
            {nodes.length === 1 && n.title && <span class="npill-title">{n.title}</span>}
          </button>
        ) : (
          <span key={i} class="npill missing" title={label}>
            {n.ref}
          </span>
        ),
      )}
    </span>
  )
}

/** The status sentence decs prints, split: the state goes in the pill, the rest is its tooltip. */
/** Short enough to sit in the pill; anything longer (a waiting reason, say) gets its own line. */
const PILL_DETAIL_MAX = 28

/** The status sentence decs prints, split: the state goes in the pill, a short detail beside it. */
export function statusParts(segs: Seg[]) {
  const [glyph, label, ...rest] = segs
  const detail = rest.map((x) => x.text.replace(/^\s*·\s*/, '')).join(' · ').trim()
  return { glyph, label: label?.text.trim() ?? '', detail, long: [...detail].length > PILL_DETAIL_MAX }
}

function StatusPill({ segs }: { segs: Seg[] }) {
  const { glyph, label, detail, long } = statusParts(segs)
  const tone = glyph ? segClass({ ...glyph, dim: false }) : ''
  return (
    <span class={`spill ${tone}`} title={detail || undefined}>
      <Glyph g={glyph} />
      <span class="spill-label">{label}</span>
      {detail && !long && <span class="spill-detail">{detail}</span>}
    </span>
  )
}

/** The same limit `nod add` / `nod retitle` hold a title to. */
const TITLE_MAX_COLS = 32

/** The title, in place: Enter saves (`nod retitle`), Esc cancels, a click outside saves too. */
function TitleField({ title, onSave, onCancel }: { title: string; onSave: (title: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useDialogFocus(ref, { select: true })
  return (
    <input
      ref={ref}
      class="node-title-edit"
      defaultValue={title}
      dir="auto"
      aria-label={s('titleEdit')}
      onInput={limitInput(TITLE_MAX_COLS)}
      onCompositionEnd={limitInput(TITLE_MAX_COLS)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onSave((e.currentTarget as HTMLInputElement).value)
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={(e) => onSave((e.currentTarget as HTMLInputElement).value)}
    />
  )
}

export function NodeHeader({
  n,
  onJump,
  listening,
  editingTitle,
  onStartTitle,
  onSaveTitle,
  onCancelTitle,
}: {
  n: Node
  onJump: (key: string) => void
  listening: { on: boolean; who: string | null } | null
  editingTitle: boolean
  onStartTitle: () => void
  onSaveTitle: (title: string) => void
  onCancelTitle: () => void
}) {
  const waitingSince = n.status === 'needs_decision' ? n.updated_at ?? n.created : null
  const steps = Array.isArray(n.steps) ? (n.steps as { label: string; done: boolean }[]) : []
  const next = steps.findIndex((x) => !x.done)
  const stale = n.staleness && n.staleness !== 'fresh'
  return (
    <header class="nhead">
      <div class="nhead-top">
        <span class="ref-pill">{n.ref}</span>
        <StatusPill segs={n.status_line} />
        {n.urgency === 'high' && !n.terminal && (
          <Chip icon={<Star {...ICON} />} tone="c-yellow">
            {s('important')}
          </Chip>
        )}
        {n.checkin && n.checkin.asked > 0 && !n.terminal && (
          <Chip icon={<MessageCircleQuestion {...ICON} />} tone={n.checkin.unanswered ? 'c-red' : ''} title={fullTime(n.checkin.last_asked_at)}>
            {n.checkin.unanswered ? s('checkinUnanswered', { count: n.checkin.asked }) : s('checkinAsked', { count: n.checkin.asked })}
          </Chip>
        )}
        {n.deferred_at && <Chip icon={<Timer {...ICON} />} tone={n.deferred_by_ai ? 'c-red' : undefined}>{n.deferred_by_ai ? s('deferredByAi') : s('deferred')}</Chip>}
        {n.brief === 'unclaimed' && (
          <Chip icon={<PenLine {...ICON} />} tone="c-blue brief">
            {s('briefWaiting')}
          </Chip>
        )}
        {n.brief === 'claimed' && n.claimed_by && (
          <Chip icon={<Bot {...ICON} />} title={fullTime(n.claimed_at)}>
            {s('briefPicked', { who: n.claimed_by.split(/\s*·\s*/)[0] })}
          </Chip>
        )}
        {listening && !n.terminal && (
          <Chip icon={<Radio {...ICON} />} tone={listening.on ? 'c-green' : 'muted'}>
            {listening.on ? s('listening', { who: listening.who?.split(/\s*·\s*/)[0] ?? 'AI' }) : s('notListening')}
          </Chip>
        )}
      </div>
      {statusParts(n.status_line).long && (
        <p class={`status-note ${segClass({ ...statusParts(n.status_line).glyph, dim: false })}`} dir="auto">
          {statusParts(n.status_line).detail}
        </p>
      )}
      {editingTitle ? (
        <TitleField title={n.title} onSave={onSaveTitle} onCancel={onCancelTitle} />
      ) : (
        <h2 class="node-title clickable" dir="auto" title={s('titleEditHint')} onClick={onStartTitle}>
          {n.title}
        </h2>
      )}
      {n.intake && n.original && n.original.trim() !== n.title.trim() && (
        <blockquote class="original" dir="auto" title={s('briefOriginal')}>
          {n.original}
        </blockquote>
      )}
      <div class="mchips">
        <Chip icon={<User {...ICON} />} title={n.author}>
          {n.who}
        </Chip>
        <Chip icon={<CalendarClock {...ICON} />} title={`${fullTime(n.created)}`} tone={stale ? 'c-red' : ''}>
          {ago(waitingSince ?? n.updated_at ?? n.created)}
        </Chip>
        {n.est && !n.terminal && (
          <Chip icon={n.est_who === 'human' ? <User {...ICON} /> : <Bot {...ICON} />} title={n.est}>
            {s(n.est_who === 'human' ? 'estHuman' : 'estAi', { est: n.est })}
          </Chip>
        )}
        {n.due && !n.milestone && (
          <Chip icon={<Timer {...ICON} />} title={fullTime(n.due)} tone={Date.parse(n.due) < Date.now() ? 'c-red' : ''}>
            {ago(n.due)}
          </Chip>
        )}
        {n.parent_node && <Pills icon={<CornerLeftUp {...ICON} />} label={s('ctxGoParent')} nodes={[n.parent_node]} onJump={onJump} />}
        <Pills icon={<GitFork {...ICON} />} label={s('afterLabel')} nodes={n.after_nodes ?? []} onJump={onJump} />
        <Pills icon={<Link2 {...ICON} />} label={s('blockingLabel')} nodes={n.blocking_nodes ?? []} onJump={onJump} />
      </div>
      {(n.approvals ?? []).length > 0 && (
        <div class="mchips approvals">
          {(n.approvals ?? []).map((ap, i) => {
            const name = ap.target.split('/').pop() || ap.target
            return (
              <Chip key={i} icon={<Paperclip {...ICON} />} tone={approvalTone(ap)} title={`${name} — ${approvalLabel(ap)}`}>
                {name} · {approvalLabel(ap)}
              </Chip>
            )
          })}
        </div>
      )}
      {(n.progress ?? 0) > 0 && (
        <div class="nprogress" title={n.progress_msg ?? undefined}>
          <Bar pct={n.progress!} color={stale ? 'red' : undefined} />
          <span class="np-pct">{n.progress}%</span>
          {n.progress_msg && <span class="np-msg">{n.progress_msg}</span>}
        </div>
      )}
      {steps.length > 0 && (
        <ol class="steps-list">
          {steps.map((st, i) => (
            <li key={i} class={st.done ? 'done' : i === next ? 'next' : ''}>
              <span class="st-mark">{st.done ? '✓' : i === next && n.status === 'in_progress' ? '◐' : '○'}</span>
              {st.label}
            </li>
          ))}
        </ol>
      )}
    </header>
  )
}
