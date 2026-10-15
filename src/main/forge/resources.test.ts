import { createResourceMonitor, parseMemory } from './resources'

const memory = (used: number) => ({
  ram: { used: 12, total: 32 },
  cuda: { system: { used, total: 24 }, allocated: { current: 10, peak: 14 },
    reserved: { current: 12, peak: 15 }, events: { oom: 2 } },
})

test('parseMemory reads Forge bytes and tolerates missing or invalid fields', () => {
  expect(parseMemory(memory(16))).toEqual({
    ramUsed: 12, ramTotal: 32, vramUsed: 16, vramTotal: 24,
    allocated: 10, reserved: 12, vramPeak: 14, oom: 2,
  })
  expect(parseMemory({ cuda: { system: { used: -3, total: '24' }, events: { oom: 1.2 } } })).toEqual({
    ramUsed: null, ramTotal: null, vramUsed: null, vramTotal: null,
    allocated: null, reserved: null, vramPeak: null, oom: null,
  })
  expect(parseMemory(null).vramUsed).toBeNull()
})

test('monitor keeps 60 samples, switches between 2s idle and 1s running, and captures job peak', async () => {
  vi.useFakeTimers()
  try {
    let used = 5
    let running: number | null = null
    const read = vi.fn(async () => parseMemory(memory(used)))
    const monitor = createResourceMonitor({ read, now: () => Date.now(), runningJob: () => running })
    monitor.start('server-1')
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(2)
    running = 7
    monitor.jobChanged()
    used = 9
    await vi.advanceTimersByTimeAsync(1000)
    expect(read).toHaveBeenCalledTimes(3)
    used = 8
    await vi.advanceTimersByTimeAsync(1000)
    expect(monitor.takePeak(7)).toBe(9)
    expect(monitor.takePeak(7)).toBeNull()
    running = null
    monitor.jobChanged()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(monitor.current().samples).toHaveLength(60)
    monitor.stop()
    const count = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read).toHaveBeenCalledTimes(count)
  } finally { vi.useRealTimers() }
})

test('monitor drops stale replies and clears history on server switch; failures stay local', async () => {
  let answer: ((value: ReturnType<typeof parseMemory>) => void) | null = null
  const read = vi.fn(() => new Promise<ReturnType<typeof parseMemory>>((resolve) => { answer = resolve }))
  const monitor = createResourceMonitor({ read, now: () => 100, runningJob: () => null })
  monitor.start('one')
  expect(read).toHaveBeenCalledTimes(1)
  const stale = answer!
  monitor.start('two')
  stale(parseMemory(memory(1)))
  await Promise.resolve()
  expect(monitor.current().samples).toEqual([])
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  answer!(parseMemory(memory(4)))
  await vi.waitFor(() => expect(monitor.current().samples[0]?.memory.vramUsed).toBe(4))
  monitor.stop()
})

test('a failed memory request marks readings stale and the next poll recovers', async () => {
  vi.useFakeTimers()
  try {
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('memory unavailable'))
      .mockResolvedValue(parseMemory(memory(6)))
    const monitor = createResourceMonitor({ read, now: () => Date.now(), runningJob: () => null })
    monitor.start('one')
    await vi.waitFor(() => expect(monitor.current().failed).toBe(true))
    expect(monitor.current().samples).toEqual([])
    await vi.advanceTimersByTimeAsync(2000)
    expect(monitor.current()).toMatchObject({ failed: false, samples: [{ memory: { vramUsed: 6 } }] })
    monitor.stop()
  } finally { vi.useRealTimers() }
})
