import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ConnectionState, ConnectionStatus } from '@shared/types'
import { t } from '../i18n/t'
import { ConnectionChip } from './ConnectionChip'

const status = (state: ConnectionState, latencyMs: number | null, attempts = 0): ConnectionStatus =>
  ({ state, latencyMs, attempts, lastOkAt: null })

test.each([
  ['connected', 38, 'Connected', '38 ms'],
  ['slow', 950, 'Slow', '950 ms'],
] as const)('%s shows its label and latency', (state, latency, label, text) => {
  render(<ConnectionChip status={status(state, latency)} onClick={() => {}} />)
  expect(screen.getByText(label)).toBeDefined()
  const value = screen.getByText(text)
  expect(value.classList.contains('mono')).toBe(true)
})

test('reconnecting shows the attempt count instead of latency', () => {
  render(<ConnectionChip status={status('reconnecting', 40, 3)} onClick={() => {}} />)
  expect(screen.getByText('Reconnecting')).toBeDefined()
  expect(screen.getByText('attempt 3')).toBeDefined()
  expect(screen.queryByText(/ ms$/)).toBeNull()
})

test('offline shows only its label', () => {
  render(<ConnectionChip status={status('offline', null)} onClick={() => {}} />)
  expect(screen.getByText('Offline')).toBeDefined()
  expect(screen.queryByText(/ ms$/)).toBeNull()
})

test('the state is conveyed by text, not only by the dot', () => {
  render(<ConnectionChip status={status('offline', null)} onClick={() => {}} />)
  const chip = screen.getByRole('button', { name: new RegExp(t('connection.offline')) })
  const dot = chip.querySelector('[data-dot]')
  expect(dot?.getAttribute('aria-hidden')).toBe('true')
  expect(dot?.textContent).toBe('')
  expect(chip.textContent).toContain('Offline')
})

test('it is a button that reports clicks', async () => {
  const onClick = vi.fn()
  render(<ConnectionChip status={status('connected', 38)} onClick={onClick} />)
  await userEvent.click(screen.getByRole('button', { name: /Connected/ }))
  expect(onClick).toHaveBeenCalledTimes(1)
})

test('without a server the chip is neutral, says so, and still opens the dialog', async () => {
  const onClick = vi.fn()
  render(<ConnectionChip status={null} onClick={onClick} />)
  const chip = screen.getByRole('button', { name: new RegExp(t('connection.none')) })
  expect(chip.textContent).toBe('No server')
  expect(chip.querySelector('[data-dot]')?.getAttribute('aria-hidden')).toBe('true')
  expect(screen.queryByText(/ ms$/)).toBeNull()
  await userEvent.click(chip)
  expect(onClick).toHaveBeenCalledTimes(1)
})
