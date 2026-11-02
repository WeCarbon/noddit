import { Bold, Code, Heading3, Italic, Link2, List, ListChecks, ListOrdered } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { s } from './strings.ts'

type Kit = {
  editor: import('@milkdown/kit/core').Editor
  call: (command: string, payload?: unknown) => void
}

/**
 * The description (or one of the owner's notes) edited in place, WYSIWYG. Milkdown is
 * loaded only when an editor opens. What comes out is markdown; the caller splices it
 * back into that one part of the file (nod edit), so nothing else is ever reformatted.
 * ⌘S or a click outside saves, Esc cancels. Pasted or dropped files go to `onFiles`.
 */
export function BodyEditor(p: { markdown: string; onSave: (markdown: string) => void; onCancel: () => void; onFiles?: (files: File[]) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const kit = useRef<Kit | null>(null)
  const latest = useRef(p.markdown)
  const dirty = useRef(false)
  const done = useRef(false)
  const [ready, setReady] = useState(false)

  const finish = (save: boolean) => {
    if (done.current) return
    done.current = true
    if (save && dirty.current && latest.current.trim() !== p.markdown.trim()) p.onSave(latest.current)
    else p.onCancel()
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const [{ Editor, rootCtx, defaultValueCtx }, cm, gfm, { listener, listenerCtx }, { history }, { clipboard }, { callCommand }] = await Promise.all([
        import('@milkdown/kit/core'),
        import('@milkdown/kit/preset/commonmark'),
        import('@milkdown/kit/preset/gfm'),
        import('@milkdown/kit/plugin/listener'),
        import('@milkdown/kit/plugin/history'),
        import('@milkdown/kit/plugin/clipboard'),
        import('@milkdown/kit/utils'),
      ])
      if (!alive || !host.current) return
      const editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, host.current!)
          ctx.set(defaultValueCtx, p.markdown)
          ctx.get(listenerCtx).markdownUpdated((_ctx, md, prev) => {
            latest.current = md
            if (prev !== undefined && md !== prev) dirty.current = true
          })
        })
        .use(cm.commonmark)
        .use(gfm.gfm)
        .use(listener)
        .use(history)
        .use(clipboard)
        .create()
      if (!alive) return void editor.destroy()
      const commands: Record<string, unknown> = {
        bold: cm.toggleStrongCommand.key,
        italic: cm.toggleEmphasisCommand.key,
        heading: cm.wrapInHeadingCommand.key,
        bullet: cm.wrapInBulletListCommand.key,
        ordered: cm.wrapInOrderedListCommand.key,
        code: cm.toggleInlineCodeCommand.key,
        link: cm.toggleLinkCommand.key,
      }
      kit.current = {
        editor,
        call: (name, payload) => editor.action(callCommand(commands[name] as never, payload as never)),
      }
      setReady(true)
      ;(host.current.querySelector('[contenteditable]') as HTMLElement | null)?.focus()
    })()
    return () => {
      alive = false
      kit.current?.editor.destroy()
    }
  }, [])

  // A click anywhere outside the editor saves it.
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const root = host.current?.closest('.body-editor')
      if (root && !root.contains(e.target as Node)) finish(true)
    }
    window.addEventListener('mousedown', away, true)
    return () => window.removeEventListener('mousedown', away, true)
  }, [])

  const tool = (name: string, icon: preact.ComponentChildren, label: string, payload?: () => unknown) => (
    <button
      class="ed-tool"
      title={label}
      aria-label={label}
      disabled={!ready}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const arg = payload?.()
        if (payload && arg === undefined) return
        kit.current?.call(name, arg)
        dirty.current = true
      }}
    >
      {icon}
    </button>
  )
  const I = { size: 14, strokeWidth: 1.9 }
  return (
    <div
      class="body-editor"
      onKeyDown={(e) => {
        e.stopPropagation()
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') (e.preventDefault(), finish(true))
        if (e.key === 'Escape') (e.preventDefault(), finish(false))
      }}
      onPaste={(e) => {
        const files = [...(e.clipboardData?.files ?? [])]
        if (files.length && p.onFiles) (e.preventDefault(), p.onFiles(files))
      }}
      onDrop={(e) => {
        const files = [...(e.dataTransfer?.files ?? [])]
        if (files.length && p.onFiles) (e.preventDefault(), p.onFiles(files))
      }}
    >
      <div class="ed-toolbar" role="toolbar">
        {tool('bold', <Bold {...I} />, s('edBold'))}
        {tool('italic', <Italic {...I} />, s('edItalic'))}
        {tool('heading', <Heading3 {...I} />, s('edHeading'), () => 3)}
        {tool('bullet', <List {...I} />, s('edBullets'))}
        {tool('ordered', <ListOrdered {...I} />, s('edNumbers'))}
        <button
          class="ed-tool"
          title={s('edChecklist')}
          aria-label={s('edChecklist')}
          disabled={!ready}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            // A task list is a bullet list whose items start with [ ]: GFM reads it back as checkboxes.
            kit.current?.call('bullet')
            document.execCommand('insertText', false, '[ ] ')
            dirty.current = true
          }}
        >
          <ListChecks {...I} />
        </button>
        {tool('code', <Code {...I} />, s('edCode'))}
        {tool('link', <Link2 {...I} />, s('edLink'), () => {
          const href = window.prompt(s('edLinkPrompt'))
          return href ? { href } : undefined
        })}
        <span class="grow" />
        <span class="ed-keys">⌘S {s('edSave')} · Esc {s('edCancel')}</span>
      </div>
      <div class="ed-host" ref={host} />
    </div>
  )
}
