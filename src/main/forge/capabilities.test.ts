import type { ConnectionStatus, ForgeCapabilities } from '@shared/types'
import type { ForgeClient } from './client'
import { createCapabilities } from './capabilities'

const status = (state: ConnectionStatus['state']): ConnectionStatus => ({ state, latencyMs: null, attempts: 0, lastOkAt: null })

function setup() {
  const flags = { value: { api_server_stop: true } as Record<string, unknown> | Error }
  const client = {
    cmdFlags: vi.fn(async () => {
      if (flags.value instanceof Error) throw flags.value
      return flags.value
    }),
  }
  const emitted: ForgeCapabilities[] = []
  const caps = createCapabilities({ client: () => client as unknown as ForgeClient, emit: (c) => emitted.push(c) })
  return { flags, client, emitted, caps }
}

test('starts with restart unavailable; refresh() reads api_server_stop and announces a change', async () => {
  const h = setup()
  expect(h.caps.current()).toEqual({ canRestart: false })
  expect(await h.caps.refresh()).toEqual({ canRestart: true })
  expect(h.emitted).toEqual([{ canRestart: true }])
  await h.caps.refresh()
  expect(h.emitted).toHaveLength(1)
  h.flags.value = { api_server_stop: false }
  await h.caps.refresh()
  expect(h.caps.current()).toEqual({ canRestart: false })
  expect(h.emitted).toEqual([{ canRestart: true }, { canRestart: false }])
})

test('a failed read keeps the last known value', async () => {
  const h = setup()
  await h.caps.refresh()
  h.flags.value = new Error('down')
  expect(await h.caps.refresh()).toEqual({ canRestart: true })
})

test('reads again each time the connection comes back, not on every sample', async () => {
  const h = setup()
  h.caps.onConnection(status('connected'))
  h.caps.onConnection(status('connected'))
  h.caps.onConnection(status('slow'))
  await vi.waitFor(() => expect(h.client.cmdFlags).toHaveBeenCalledTimes(1))
  h.caps.onConnection(status('reconnecting'))
  h.caps.onConnection(status('connected'))
  await vi.waitFor(() => expect(h.client.cmdFlags).toHaveBeenCalledTimes(2))
})

test('reset() (server switch) clears the value and drops an older read still in flight', async () => {
  const h = setup()
  let release!: () => void
  h.client.cmdFlags.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ api_server_stop: true }) }))
  const late = h.caps.refresh()
  h.caps.reset()
  release()
  await late
  expect(h.caps.current()).toEqual({ canRestart: false })
  expect(h.emitted).toEqual([])
})
