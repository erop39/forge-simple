import type { ConnectionStatus, ForgeCapabilities } from '@shared/types'
import type { ForgeClient } from './client'

/**
 * What the active Forge allows, read from its launch flags (`/cmd-flags`). Read again whenever the
 * connection comes back (a restarted Forge may run with other flags) and after a server switch.
 */
export function createCapabilities(deps: { client(): ForgeClient; emit(c: ForgeCapabilities): void }) {
  let current: ForgeCapabilities = { canRestart: false }
  let seq = 0
  let connected = false

  function set(next: ForgeCapabilities): void {
    if (next.canRestart === current.canRestart) return
    current = next
    try {
      deps.emit(current)
    } catch (err) {
      console.error('capabilities: emit failed', err)
    }
  }

  /** A failed read keeps the last known value; a read that a reset() overtook is dropped. */
  async function refresh(): Promise<ForgeCapabilities> {
    const mine = ++seq
    try {
      const flags = await deps.client().cmdFlags()
      if (mine === seq) set({ canRestart: flags['api_server_stop'] === true })
    } catch {
      // Forge may be restarting; the next reconnect reads again.
    }
    return current
  }

  return {
    current: (): ForgeCapabilities => current,
    refresh,
    onConnection(status: ConnectionStatus): void {
      const ok = status.state === 'connected' || status.state === 'slow'
      if (ok && !connected) void refresh()
      connected = ok
    },
    /** The active server changed: nothing is known about the new one yet. */
    reset(): void {
      seq++
      connected = false
      set({ canRestart: false })
    },
  }
}
