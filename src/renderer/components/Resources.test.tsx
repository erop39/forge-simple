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
const panel = (): HTMLElement => screen.getByRole('region', { name: en['resources.title'] })

test('the panel is closed until the button is pressed, then falls back to Forge memory and explains the missing extension', async () => {
  const onOpenServer = vi.fn()
  renderWithStore(<Resources onOpenServer={onOpenServer} />, 'sdxl', {
    connection: { state: 'connected', latencyMs: 30, attempts: 0, lastOkAt: 1 },
    resources: { samples: [{ time: 1, memory, stats: null }], failed: false, extension: 'absent' },
  })
  expect(screen.queryByRole('region', { name: en['resources.title'] })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: en['resources.open'] }))
  expect(panel().textContent).toContain('16.0 GiB')
  expect(panel().textContent).toContain('12.0 GiB')
  expect(screen.getByText(en['resources.extensionHint'])).toBeDefined()
  expect(screen.getByText('Out-of-memory events').nextSibling?.textContent).toBe('2')
  await userEvent.click(screen.getByRole('button', { name: en['resources.switchServer'] }))
  expect(onOpenServer).toHaveBeenCalledOnce()
})

test('Escape and the close button hide the panel', async () => {
  renderWithStore(<Resources onOpenServer={() => {}} />, 'sdxl', {
    connection: { state: 'connected', latencyMs: 30, attempts: 0, lastOkAt: 1 },
    resources: { samples: [{ time: 1, memory, stats: null }], failed: false, extension: 'absent' },
  })
  const open = screen.getByRole('button', { name: en['resources.open'] })
  await userEvent.click(open)
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('region', { name: en['resources.title'] })).toBeNull()
  await userEvent.click(open)
  await userEvent.click(screen.getByRole('button', { name: en['resources.close'] }))
  expect(screen.queryByRole('region', { name: en['resources.title'] })).toBeNull()
})

test('extension values fill CPU and GPU; failed memory polling blanks the current values', async () => {
  const { store } = renderWithStore(<Resources onOpenServer={() => {}} />, 'sdxl', {
    connection: { state: 'connected', latencyMs: 30, attempts: 0, lastOkAt: 1 },
    resources: { samples: [{ time: 1, memory, stats: {
      version: '1', forgeVersion: null, torchVersion: null, cpuPercent: 55,
      ramUsed: 20 * GB, ramTotal: 32 * GB, gpuName: 'Test GPU', gpuUtilization: 88,
      gpuTemperature: null, gpuFanPercent: null, gpuPowerWatts: null, gpuPowerLimitWatts: null,
      gpuVramUsed: 18 * GB, gpuVramTotal: 24 * GB,
    } }], failed: false, extension: 'available' },
  })
  await userEvent.click(screen.getByRole('button', { name: en['resources.open'] }))
  expect(panel().textContent).toContain('55%')
  expect(panel().textContent).toContain('88%')
  act(() => store.setState((s) => ({ resources: { ...s.resources, failed: true } })))
  expect(panel().textContent).not.toContain('55%')
})

test('usage thresholds are inclusive at 90% and 97%', () => {
  expect(level(89, 100)).toBe('normal')
  expect(level(90, 100)).toBe('warn')
  expect(level(97, 100)).toBe('critical')
  expect(level(null, 100)).toBe('normal')
})

test('offline connection hides stale resource values', async () => {
  renderWithStore(<Resources onOpenServer={() => {}} />, 'sdxl', {
    connection: { state: 'offline', latencyMs: null, attempts: 2, lastOkAt: 1 },
    resources: { samples: [{ time: 1, memory, stats: null }], failed: false, extension: 'absent' },
  })
  await userEvent.click(screen.getByRole('button', { name: en['resources.open'] }))
  expect(panel().textContent).not.toContain('16.0 GiB')
})
