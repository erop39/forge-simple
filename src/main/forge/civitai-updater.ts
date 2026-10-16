import type { CivitaiInfo, CivitaiProgress, ModelKind } from '@shared/types'
import { CivitaiBusyError, type CivitaiClient } from './civitai'

export interface UpdaterItem { serverId: number; kind: ModelKind; id: string; hash: string; checkedAt: number | null }

export interface UpdaterDeps {
  client: CivitaiClient
  /** What to look up: the active server's checkpoints and LoRA that have a hash. */
  items(): UpdaterItem[]
  /** Stores an answer: the version info, or null when Civitai does not know the file. */
  save(item: UpdaterItem, info: CivitaiInfo | null): void
  now(): number
  emit(progress: CivitaiProgress): void
  sleep(ms: number, signal: AbortSignal): Promise<void>
  /** Pause between requests, so a big library is looked up slowly. */
  gapMs?: number
  /** A file looked up this recently is skipped unless the run is forced. */
  freshMs?: number
}

export interface Updater {
  /** Starts a run unless one is going; resolves when it ends. */
  start(opts?: { force?: boolean }): Promise<void>
  cancel(): void
  /** Stores one answer the same way a run does (used by the single-file update). */
  record(item: UpdaterItem, info: CivitaiInfo | null): void
  state(): CivitaiProgress
}

const DAY = 24 * 60 * 60 * 1000

/** Looks the library up on Civitai one file at a time, slowly, and can be cancelled between requests. */
export function createCivitaiUpdater(deps: UpdaterDeps): Updater {
  const gap = deps.gapMs ?? 1100
  const fresh = deps.freshMs ?? 30 * DAY
  let progress: CivitaiProgress = { running: false, done: 0, total: 0, found: 0, paused: false }
  let controller: AbortController | null = null
  let current: Promise<void> | null = null

  const set = (next: Partial<CivitaiProgress>): void => {
    progress = { ...progress, ...next }
    deps.emit(progress)
  }

  async function run(force: boolean, signal: AbortSignal): Promise<void> {
    const items = deps.items().filter((i) => force || i.checkedAt === null || deps.now() - i.checkedAt > fresh)
    set({ running: true, done: 0, total: items.length, found: 0, paused: false })
    try {
      for (const item of items) {
        if (signal.aborted) break
        for (let attempt = 0; ; attempt++) {
          try {
            const info = await deps.client.lookup(item.hash, signal)
            deps.save(item, info)
            if (info) set({ found: progress.found + 1 })
            break
          } catch (err) {
            if (signal.aborted) break
            if (err instanceof CivitaiBusyError && attempt < 3) {
              set({ paused: true })
              await deps.sleep(err.retryAfterMs, signal)
              set({ paused: false })
              continue
            }
            break // one file's failure leaves it unchecked; the run goes on
          }
        }
        set({ done: progress.done + 1 })
        if (!signal.aborted) await deps.sleep(gap, signal)
      }
    } finally {
      set({ running: false, paused: false })
    }
  }

  return {
    start(opts = {}) {
      if (current) return current
      controller = new AbortController()
      const signal = controller.signal
      current = run(opts.force === true, signal).finally(() => { current = null; controller = null })
      return current
    },
    cancel() {
      controller?.abort()
    },
    record: (item, info) => deps.save(item, info),
    state: () => progress,
  }
}
