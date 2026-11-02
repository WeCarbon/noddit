import { Paperclip, X } from 'lucide-preact'
import { useEffect, useState } from 'preact/hooks'
import { s } from './strings.ts'

/** Files from a paste or a drop — only when there are some, so plain text pastes as text. */
export function filesOf(data: DataTransfer | null): File[] {
  return data ? [...data.files] : []
}

function FileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const image = file.type.startsWith('image/')
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!image) return
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  const name = file.name || 'pasted.png'
  return (
    <span class={`draft-file ${image ? 'image' : ''}`} title={name}>
      {url ? <img src={url} alt="" /> : <Paperclip size={13} strokeWidth={1.75} />}
      {!image && <span class="draft-file-name">{name}</span>}
      <button class="draft-file-x" aria-label={s('removeFile', { name })} onClick={onRemove}>
        <X size={12} strokeWidth={2} />
      </button>
    </span>
  )
}

/** The files waiting to go with a message: thumbnails for images, a chip for the rest, each removable. */
export function DraftFiles({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  if (!files.length) return null
  return (
    <div class="draft-files">
      {files.map((f, i) => (
        <FileChip key={`${i}-${f.name}-${f.size}`} file={f} onRemove={() => onRemove(i)} />
      ))}
    </div>
  )
}
