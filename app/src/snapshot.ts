/**
 * The bench snapshot the next launch paints first. A bench is megabytes, and it is reread on
 * every change, so writing each one would rewrite megabytes many times a minute (macOS flagged
 * the app for gigabytes of disk writes). It is written at most once per `everyMs`, only when it
 * changed, and once more when the window hides or the app quits.
 */
export function snapshotWriter(write: (json: string) => unknown, everyMs: number, now: () => number = Date.now) {
  let pending: string | null = null
  let last = ''
  let lastAt = -Infinity
  const flush = () => {
    if (pending === null || pending === last) return (pending = null)
    last = pending
    pending = null
    lastAt = now()
    void write(last)
  }
  return {
    /** Remembers the newest bench; writes it only if the last write is old enough. */
    offer(json: string) {
      pending = json
      if (now() - lastAt >= everyMs) flush()
    },
    /** Writes whatever is newer than what is on disk, now. */
    flush,
  }
}
