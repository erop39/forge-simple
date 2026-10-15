import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MemoryMetrics } from '@shared/types'
import { en } from '../locales/en'
import { renderWithStore } from './test-store'
import { Resources, level } from './Resources'

const GB = 1024 ** 3
const memory: MemoryMetrics = {
  ramUsed: 12 * GB, ramTotal: 32 * GB, vramUsed: 16 * GB, vramTotal: 24 * GB,
  allocated: 10 * GB, reserved: 12 * GB, vramPeak: 14 * GB, oom: 2,
}

test('resource strip falls back to Forge memory and the detail panel explains missing extension metrics', async () => {
  const onOpenServer = vi.fn()
  renderWithStore(<Resources onOpenServer={onOpenServer} />, 'sdxl', {
    connection: { state: 'connected', latencyMs: 30, attempts: 0, lastOkAt: 1 },
    resources: { samples: [{ time: 1, memory, stats: null }], failed: false, extension: 'absent' },
  })
  const strip = screen.getByRole('button', { name: en['resources.open'] })
  expect(strip.textContent).toContain('16.0 GiB')
  expect(strip.textContent).toContain('12.0 GiB')
  expect(strip.textContent).toContain('—')
  await userEvent.click(strip)
  expect(screen.getByText(en['resources.extensionHint'])).toBeDefined()
  expect(screen.getByText(/Out-of-memory events: 2/)).toBeDefined()
  await userEvent.click(screen.getByRole('button', { name: en['resources.switchServer'] }))
  expect(onOpenServer).toHaveBeenCalledOnce()
})

test('extension values fill CPU and GPU; failed memory polling blanks the current strip', () => {
  const { store } = renderWithStore(<Resources onOpenServer={() => {}} />, 'sdxl', {
    connection: { state: 'connected', latencyMs: 30, attempts: 0, lastOkAt: 1 },
    resources: { samples: [{ time: 1, memory, stats: {
      version: '1', forgeVersion: null, torchVersion: null, cpuPercent: 55,
      ramUsed: 20 * GB, ramTotal: 32 * GB, gpuName: 'Test GPU', gpuUtilization: 88,
      gpuTemperature: null, gpuFanPercent: null, gpuPowerWatts: null, gpuPowerLimitWatts: null,
      gpuVramUsed: 18 * GB, gpuVramTotal: 24 * GB,
    } }], failed: false, extension: 'available' },
  })
  const strip = screen.getByRole('button', { name: en['resources.open'] })
  expect(strip.textContent).toContain('55%')
  expect(strip.textContent).toContain('88%')
  act(() => store.setState((s) => ({ resources: { ...s.resources, failed: true } })))
  expect(strip.textContent).not.toContain('55%')
})

test('usage thresholds are inclusive at 90% and 97%', () => {
  expect(level(89, 100)).toBe('normal')
  expect(level(90, 100)).toBe('warn')
  expect(level(97, 100)).toBe('critical')
  expect(level(null, 100)).toBe('normal')
})

test('offline connection hides stale resource values', () => {
  renderWithStore(<Resources onOpenServer={() => {}} />, 'sdxl', {
    connection: { state: 'offline', latencyMs: null, attempts: 2, lastOkAt: 1 },
    resources: { samples: [{ time: 1, memory, stats: null }], failed: false, extension: 'absent' },
  })
  expect(screen.getByRole('button', { name: en['resources.open'] }).textContent).not.toContain('16.0 GiB')
})
