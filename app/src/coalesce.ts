/**
 * Runs `fn` to completion, folding concurrent calls into one pass after the one
 * already running — never two overlapping. The call that asks for one more pass
 * might land just as the running one is about to finish; that request is only
 * honored if it is seen before the run is marked finished, so finishing and the
 * "run again" check happen in the same synchronous step, with no awaited gap
 * between them where a request could be set and then never looked at again.
 */
export function coalesce(fn: () => Promise<void>): () => Promise<void> {
  let inflight: Promise<void> | null = null
  let again = false
  return function run(): Promise<void> {
    if (inflight) {
      again = true
      return inflight
    }
    inflight = (async () => {
      do {
        again = false
        try {
          await fn()
        } catch {
          /* the caller decides what a failure means; a request made meanwhile still retries */
        }
      } while (again)
      // Same synchronous step as the `while` check above finding nothing more to do: a `run()`
      // that reads `inflight` cannot observe it as settled-but-still-set, which is what used to
      // let a request land right after the loop gave up and get silently dropped.
      inflight = null
    })()
    return inflight
  }
}
